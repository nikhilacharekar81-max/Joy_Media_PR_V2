import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { store, type Message, type Notification } from './store.js';
import { verifyToken, getUserActiveSessions, validateTokenSessionVersion, canAccessOrderWorkstream, isStaffUser } from './middleware/auth.js';
import { recordMessage, sanitizeAndCreateMessage } from './services/messagingService.js';
import { validateMessageFileInfo, workstreamFilenameFromUrl } from './services/workstreamService.js';
import { postgresStore, isRemotePostgresConfigured } from './db/postgresStore.js';
import { diagnosticService } from './services/diagnosticService.js';
import { siteSettings } from './domains/admin/siteSettings.js';

export const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

const wsConnectionBuckets = new Map<string, { count: number; resetAt: number }>();

function isTrustedProxyPeer(remoteAddress?: string): boolean {
  if (!remoteAddress) return false;
  if (process.env.TRUST_PROXY === 'false' || process.env.TRUST_PROXY === '0') return false;
  const addr = remoteAddress.replace(/^::ffff:/, '');
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr.startsWith('10.') ||
    addr.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr) ||
    addr.startsWith('169.254.')
  );
}

function resolveWsClientIp(request: any): string {
  const socketIp = request?.socket?.remoteAddress || 'unknown';
  if (isTrustedProxyPeer(socketIp)) {
    const xff = request?.headers?.['x-forwarded-for'];
    const parts = (Array.isArray(xff) ? xff.join(',') : (xff || ''))
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }
  return socketIp.replace(/^::ffff:/, '') || 'unknown';
}

function checkWsIpRateLimit(ip: string, max = 50, windowMs = 60000): boolean {
  const now = Date.now();
  const record = wsConnectionBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count++;
  wsConnectionBuckets.set(ip, record);
  return record.count <= max;
}

// Periodic cleanup for expired IP rate-limit entries
const wsCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of wsConnectionBuckets.entries()) {
    if (now > rec.resetAt) {
      wsConnectionBuckets.delete(ip);
    }
  }
}, 300000);
if (wsCleanupInterval && typeof wsCleanupInterval.unref === 'function') {
  wsCleanupInterval.unref();
}

export function initWebSocketServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    const protocol = String(request?.headers?.['sec-websocket-protocol'] || '');
    if (protocol.includes('vite-hmr')) {
      socket.destroy();
      return;
    }

    const originHeader = String(request?.headers?.origin || '').trim();
    if (originHeader) {
      let originAllowed = false;
      try {
        const parsedOrigin = new URL(originHeader);
        const reqHost = String(request?.headers?.['x-forwarded-host'] || request?.headers?.host || '').split(',')[0].trim().toLowerCase();
        const appUrlEnv = String(process.env.APP_URL || '').trim();
        const allowedHosts = new Set<string>();
        if (reqHost) allowedHosts.add(reqHost);
        if (appUrlEnv) {
          try { allowedHosts.add(new URL(appUrlEnv).host.toLowerCase()); } catch {}
        }
        if (allowedHosts.has(parsedOrigin.host.toLowerCase())) {
          originAllowed = true;
        }
      } catch {
        originAllowed = false;
      }
      if (!originAllowed) {
        console.warn(`[Security] WebSocket upgrade rejected due to untrusted Origin: ${originHeader}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const ip = resolveWsClientIp(request);
    if (!checkWsIpRateLimit(ip)) {
      console.warn(`[Security] WebSocket connection attempt from ${ip} rejected: rate limit exceeded.`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    
    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  wss.on('error', (err) => {
    console.error('WSS Server error:', err);
  });

  wss.on('connection', async (ws) => {
    try {
      clients.add(ws);
      (ws as any).isAuthenticated = false;

      // Authenticate only via post-connection AUTHENTICATE message
      const timeoutMs = process.env.NODE_ENV === 'test' ? 1000 : 10000;
      const authTimeout = setTimeout(() => {
        if (!(ws as any).isAuthenticated) {
          clients.delete(ws);
          try { ws.close(1008, 'Authentication timeout'); } catch {}
        }
      }, timeoutMs);
      if (authTimeout && typeof authTimeout.unref === 'function') {
        authTimeout.unref();
      }

      setupWebSocketHandlers(ws, authTimeout);
    } catch (err) {
      console.error('WS Connection error:', err);
      clients.delete(ws);
      try { ws.close(1011, 'Server error during connection'); } catch {}
    }
  });

  return wss;
}

const locallyBroadcastMessageIds = new Set<string>();
const locallyBroadcastNotificationIds = new Set<string>();
let lastCrossInstanceMsgTs = new Date().toISOString();
let lastCrossInstanceMsgId = '';
let lastCrossInstanceNotifTs = new Date().toISOString();
let lastCrossInstanceNotifId = '';

function normalizeDbTimestamp(val: any): string {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function rememberBroadcastId(set: Set<string>, id?: string) {
  if (!id) return;
  set.add(id);
  if (set.size > 1000) {
    const first = set.values().next().value;
    if (first) set.delete(first);
  }
}

const crossInstanceWsInterval = setInterval(async () => {
  if (clients.size === 0 || !isRemotePostgresConfigured()) return;
  try {
    const pool = postgresStore.getPool();
    const [msgRes, notifRes] = await Promise.all([
      pool.query(
        'SELECT * FROM messages WHERE (timestamp > $1 OR (timestamp = $1 AND id > $2)) ORDER BY timestamp ASC, id ASC LIMIT 50',
        [lastCrossInstanceMsgTs, lastCrossInstanceMsgId]
      ),
      pool.query(
        'SELECT * FROM notifications WHERE (created_at > $1 OR (created_at = $1 AND id > $2)) ORDER BY created_at ASC, id ASC LIMIT 50',
        [lastCrossInstanceNotifTs, lastCrossInstanceNotifId]
      )
    ]);

    for (const r of msgRes.rows) {
      const rowTs = normalizeDbTimestamp(r.timestamp);
      const rowId = String(r.id || '');
      if (rowTs && (rowTs > lastCrossInstanceMsgTs || (rowTs === lastCrossInstanceMsgTs && rowId > lastCrossInstanceMsgId))) {
        lastCrossInstanceMsgTs = rowTs;
        lastCrossInstanceMsgId = rowId;
      }
      if (!locallyBroadcastMessageIds.has(rowId)) {
        rememberBroadcastId(locallyBroadcastMessageIds, rowId);
        let fileInfo = r.file_info;
        if (typeof fileInfo === 'string') {
          try { fileInfo = JSON.parse(fileInfo); } catch { fileInfo = undefined; }
        }
        let metadata = r.metadata;
        if (typeof metadata === 'string') {
          try { metadata = JSON.parse(metadata); } catch { metadata = undefined; }
        }
        const msg: Message = {
          id: rowId,
          orderId: r.order_id || undefined,
          workspaceId: r.workspace_id || undefined,
          senderId: r.sender_id,
          senderName: r.sender_name,
          text: r.text,
          timestamp: rowTs || r.timestamp,
          type: r.type,
          fileInfo: fileInfo || undefined,
          metadata: metadata || undefined
        };
        const targetId = msg.orderId || msg.workspaceId;
        if (targetId) {
          await broadcastMessage(msg, targetId);
        }
      }
    }

    for (const r of notifRes.rows) {
      const rowTs = normalizeDbTimestamp(r.created_at);
      const rowId = String(r.id || '');
      if (rowTs && (rowTs > lastCrossInstanceNotifTs || (rowTs === lastCrossInstanceNotifTs && rowId > lastCrossInstanceNotifId))) {
        lastCrossInstanceNotifTs = rowTs;
        lastCrossInstanceNotifId = rowId;
      }
      if (!locallyBroadcastNotificationIds.has(rowId) && r.user_id) {
        rememberBroadcastId(locallyBroadcastNotificationIds, rowId);
        const notif: Notification = {
          id: rowId,
          userId: r.user_id,
          type: r.type,
          title: r.title,
          message: r.message,
          link: r.link || undefined,
          read: Boolean(r.read),
          createdAt: rowTs || r.created_at,
          dedupKey: r.dedup_key || undefined,
          actorId: r.actor_id || undefined
        };
        broadcastNotificationToUser(notif.userId, notif);
      }
    }
  } catch {}
}, 5000);
if (crossInstanceWsInterval && typeof crossInstanceWsInterval.unref === 'function') {
  crossInstanceWsInterval.unref();
}

export async function broadcastMessage(message: Message, orderId: string) {
  rememberBroadcastId(locallyBroadcastMessageIds, message.id);
  const payload = JSON.stringify({ type: 'MESSAGE_RECEIVED', message });
  const updatePayload = JSON.stringify({
    type: 'WORKSTREAM_UPDATED',
    orderId,
    lastMessage: message.text,
    lastMessageTime: message.timestamp
  });

  const order = await store.getOrder(orderId);
  let buyerId = order?.buyerId;
  let sellerId = order?.sellerId;
  if (!order) {
    const ws = await postgresStore.getWorkspace(orderId);
    if (ws) {
      buyerId = ws.buyerId;
      sellerId = ws.sellerId;
    } else {
      return;
    }
  }

  const senderId = message.senderId;

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && (client as any).isAuthenticated) {
      const clientUserId = (client as any).authenticatedUserId;
      if (!clientUserId) continue;
      const clientRole = (client as any).role;
      const isParticipant =
        clientUserId === senderId ||
        clientUserId === buyerId ||
        clientUserId === sellerId ||
        clientUserId === (order as any)?.clientId ||
        clientUserId === (order as any)?.freelancerId;
      const isSubscribedStaff =
        isStaffUser({ role: clientRole }) &&
        (orderId.startsWith('support_admin_') ||
          ((client as any).subscribedOrderIds instanceof Set && (client as any).subscribedOrderIds.has(orderId)));
      const isAuthorized = isParticipant || isSubscribedStaff;

      if (isAuthorized) {
        try {
          client.send(payload);
          client.send(updatePayload);
        } catch {}
      }
    }
  }
}

export function broadcastNotificationToUser(userId: string, notification: Notification) {
  rememberBroadcastId(locallyBroadcastNotificationIds, notification.id);
  for (const client of clients) {
    if ((client as any).isAuthenticated && (client as any).authenticatedUserId === userId && client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify({ type: 'NOTIFICATION', notification }));
      } catch {}
    }
  }
}

export function disconnectUserSockets(userId: string, reason = 'Session invalidated') {
  for (const client of clients) {
    if ((client as any).authenticatedUserId === userId) {
      try { client.close(4401, reason); } catch {}
    }
  }
}

export function disconnectUserSessionSocket(userId: string, sessionVersion: number, reason = 'Session expired (max 3 devices)') {
  for (const client of clients) {
    if ((client as any).authenticatedUserId === userId && (client as any).sessionVersion === sessionVersion) {
      try { client.close(4401, reason); } catch {}
    }
  }
}

function setupWebSocketHandlers(ws: WebSocket, authTimeout?: NodeJS.Timeout) {
  let messageCount = 0;
  let resetTime = Date.now() + 10000;
  let authAttempts = 0;

  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        ws.send(JSON.stringify({ error: 'Binary messages not supported' }));
        return;
      }

      const rawStr = data.toString();
      if (rawStr.length > 10240) {
        diagnosticService.log('security', 'websocket', 'onMessage', 'server/websocket.ts', 'payload_size_check', 'INTERCEPTED', { length: rawStr.length }, 'Oversized WebSocket message payload rejected (> 10KB)');
        ws.send(JSON.stringify({ error: 'Message payload exceeds maximum allowed size' }));
        return;
      }

      const now = Date.now();
      if (now > resetTime) {
        messageCount = 1;
        resetTime = now + 10000;
      } else {
        messageCount++;
        if (messageCount > 30) {
          diagnosticService.log('warning', 'websocket', 'onMessage', 'server/websocket.ts', 'rate_limit', 'INTERCEPTED', { messageCount }, 'WebSocket message rate limit exceeded');
          ws.send(JSON.stringify({ error: 'Rate limit exceeded. Please slow down.' }));
          return;
        }
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawStr);
      } catch {
        ws.send(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      if (parsed.type === 'AUTHENTICATE') {
        authAttempts++;
        if (authAttempts > 3) {
          diagnosticService.log('security', 'websocket', 'authenticate', 'server/websocket.ts', 'auth_attempts', 'INTERCEPTED', { authAttempts }, 'Too many authentication attempts');
          ws.send(JSON.stringify({ error: 'Too many authentication attempts' }));
          clients.delete(ws);
          try { ws.close(1008, 'Too many auth attempts'); } catch {}
          return;
        }

        const token = parsed.token;
        if (!token) {
          ws.send(JSON.stringify({ error: 'Token is required' }));
          return;
        }

        const payload = verifyToken(token);
        if (payload && payload.id) {
          try {
            const dbUser = await store.getUser(payload.id);
            if (dbUser && dbUser.status !== 'deactivated') {
              if (!validateTokenSessionVersion(payload, dbUser)) {
                ws.send(JSON.stringify({ error: 'Session revoked' }));
                clients.delete(ws);
                try { ws.close(1008, 'Session revoked'); } catch {}
                return;
              }
              (ws as any).authenticatedUserId = dbUser.id;
              (ws as any).role = dbUser.role;
              (ws as any).sessionVersion = typeof payload.sessionVersion === 'number' ? payload.sessionVersion : Number(dbUser.sessionVersion || 1);
              (ws as any).isAuthenticated = true;
              if (authTimeout) clearTimeout(authTimeout);

              if (!(ws as any).hasSentConnected) {
                (ws as any).hasSentConnected = true;
                ws.send(JSON.stringify({
                  type: 'CONNECTED',
                  userId: dbUser.id,
                  serverTime: new Date().toISOString()
                }));
              }
              return;
            }
          } catch (err) {
            ws.send(JSON.stringify({ error: 'Authentication service unavailable' }));
            clients.delete(ws);
            try { ws.close(1008, 'Authentication service unavailable'); } catch {}
            return;
          }
        }

        diagnosticService.log('security', 'websocket', 'authenticate', 'server/websocket.ts', 'verify_token', 'INTERCEPTED', {}, 'Invalid token or deactivated account on WebSocket authenticate');
        ws.send(JSON.stringify({ error: 'Invalid token' }));
        clients.delete(ws);
        try { ws.close(1008, 'Authentication failed'); } catch {}
        return;
      }

      if (!(ws as any).isAuthenticated) {
        ws.send(JSON.stringify({ error: 'Authentication required' }));
        return;
      }

      const currentDbUser = await store.getUser((ws as any).authenticatedUserId);
      const wsSessionVer = (ws as any).sessionVersion;
      if (!currentDbUser || currentDbUser.status === 'deactivated') {
        diagnosticService.log('security', 'websocket', 'checkSession', 'server/websocket.ts', 'account_status', 'INTERCEPTED', { userId: (ws as any).authenticatedUserId }, 'Session invalidated or account deactivated on message');
        clients.delete(ws);
        try { ws.close(1008, 'Session invalidated or account deactivated'); } catch {}
        return;
      }
      if (wsSessionVer !== undefined) {
        const activeSessions = getUserActiveSessions(currentDbUser);
        if (!activeSessions.includes(wsSessionVer) && wsSessionVer !== currentDbUser.sessionVersion) {
          clients.delete(ws);
          try { ws.close(1008, 'Session invalidated or evicted (max 3 devices)'); } catch {}
          return;
        }
      }

      if (parsed.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG' }));
        return;
      }

      if (parsed.type === 'SUBSCRIBE_WORKSTREAM') {
        const subOrderId = typeof parsed.orderId === 'string' ? parsed.orderId.trim() : '';
        if (!subOrderId) {
          ws.send(JSON.stringify({ error: 'Order ID is required' }));
          return;
        }
        const subOrder = await store.getOrder(subOrderId);
        let canSubscribe = Boolean(subOrder && canAccessOrderWorkstream(currentDbUser, subOrder));
        if (!canSubscribe && !subOrder) {
          const workspace = await postgresStore.getWorkspace(subOrderId);
          if (workspace) {
            canSubscribe =
              isStaffUser(currentDbUser) ||
              workspace.buyerId === currentDbUser.id ||
              workspace.sellerId === currentDbUser.id;
          }
        }
        if (!canSubscribe) {
          ws.send(JSON.stringify({ error: 'Unauthorized to subscribe to this workstream' }));
          return;
        }
        if (!((ws as any).subscribedOrderIds instanceof Set)) {
          (ws as any).subscribedOrderIds = new Set<string>();
        }
        (ws as any).subscribedOrderIds.add(subOrderId);
        ws.send(JSON.stringify({ type: 'WORKSTREAM_SUBSCRIBED', orderId: subOrderId }));
        return;
      }

      if (parsed.type === 'UNSUBSCRIBE_WORKSTREAM') {
        const unsubOrderId = typeof parsed.orderId === 'string' ? parsed.orderId.trim() : '';
        if ((ws as any).subscribedOrderIds instanceof Set && unsubOrderId) {
          (ws as any).subscribedOrderIds.delete(unsubOrderId);
        }
        ws.send(JSON.stringify({ type: 'WORKSTREAM_UNSUBSCRIBED', orderId: unsubOrderId }));
        return;
      }

      if (parsed.type === 'NEW_MESSAGE') {
        const orderId = parsed.orderId;
        if (!orderId) {
          ws.send(JSON.stringify({ error: 'Order ID is required' }));
          return;
        }

        if (siteSettings.getSettings().website?.maintenanceMode && !isStaffUser(currentDbUser)) {
          ws.send(JSON.stringify({ error: 'Platform is currently in maintenance mode.' }));
          return;
        }

        const userStatus = String((currentDbUser as any).status || 'active').toLowerCase();
        if ((userStatus === 'suspended' || userStatus === 'restricted' || userStatus === 'frozen') && !orderId.startsWith('support_admin_')) {
          ws.send(JSON.stringify({ error: `Action forbidden: Your account is ${userStatus}. You can only message Support.` }));
          return;
        }

        const order = await store.getOrder(orderId);
        if (!order) {
          diagnosticService.log('warning', 'websocket', 'onNewMessage', 'server/websocket.ts', 'order_lookup', 'FAILED', { orderId }, 'Order not found for WebSocket message');
          ws.send(JSON.stringify({ error: 'Order not found' }));
          return;
        }
        if (!canAccessOrderWorkstream(currentDbUser, order)) {
          diagnosticService.log('security', 'websocket', 'onNewMessage', 'server/websocket.ts', 'order_authorization', 'INTERCEPTED', { orderId, userId: currentDbUser.id }, 'Unauthorized user attempted to message on order');
          ws.send(JSON.stringify({ error: 'Unauthorized to send messages in this order' }));
          return;
        }
        if (isStaffUser(currentDbUser)) {
          if (!((ws as any).subscribedOrderIds instanceof Set)) {
            (ws as any).subscribedOrderIds = new Set<string>();
          }
          (ws as any).subscribedOrderIds.add(order.id);
        }
        if (order.isMuted && !isStaffUser(currentDbUser)) {
          diagnosticService.log('warning', 'websocket', 'onNewMessage', 'server/websocket.ts', 'mute_check', 'INTERCEPTED', { orderId }, 'Chat is currently muted by Administrator');
          ws.send(JSON.stringify({ error: 'Chat is currently muted by Administrator.' }));
          return;
        }

        const fileCheck = await validateMessageFileInfo(parsed.fileInfo, currentDbUser);
        if (!fileCheck.ok) {
          ws.send(JSON.stringify({ error: (fileCheck as any).error }));
          return;
        }

        const clientMessageId = typeof parsed.clientMessageId === 'string'
          ? parsed.clientMessageId
          : (typeof parsed.metadata?.clientMessageId === 'string' ? parsed.metadata.clientMessageId : undefined);
        if (clientMessageId) {
          const existingMsg = await store.getMessageByClientMsgId(order.id, currentDbUser.id, clientMessageId);
          if (existingMsg) {
            ws.send(JSON.stringify({ type: 'MESSAGE_RECEIVED', message: existingMsg, deduplicated: true }));
            return;
          }
        }

        const newMsg = sanitizeAndCreateMessage(currentDbUser, order, parsed, fileCheck);
        if (newMsg.fileInfo?.url) {
          const fn = workstreamFilenameFromUrl(newMsg.fileInfo.url);
          if (fn) {
            await postgresStore.getPool().query('UPDATE uploads SET order_id = $1 WHERE filename = $2 AND order_id IS NULL', [order.id, fn]);
          }
        }

        try {
          // Persist to PostgreSQL database FIRST (recordMessage handles broadcast)
          await recordMessage(newMsg);
        } catch (msgErr: any) {
          if (clientMessageId) {
            const existingMsg = await store.getMessageByClientMsgId(order.id, currentDbUser.id, clientMessageId);
            if (existingMsg) {
              ws.send(JSON.stringify({ type: 'MESSAGE_RECEIVED', message: existingMsg, deduplicated: true }));
              return;
            }
          }
          throw msgErr;
        }

        diagnosticService.log('info', 'websocket', 'onNewMessage', 'server/websocket.ts', 'send_message', 'SUCCESS', { orderId: order.id, messageId: newMsg.id });
        return;
      }
    } catch (e) {
      console.error('WS message processing error:', e);
    }
  });

  ws.on('error', (err) => {
    console.warn('WebSocket client error:', err?.message || err);
    if (authTimeout) clearTimeout(authTimeout);
    clients.delete(ws);
  });

  ws.on('close', () => {
    if (authTimeout) clearTimeout(authTimeout);
    clients.delete(ws);
  });
}
