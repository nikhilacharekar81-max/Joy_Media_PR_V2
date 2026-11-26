import { useMemo } from 'react';
import { compareMessageTime } from '../../utils/messageTime';
import { Order, UserAccount, Gig, Message, isStaffRole } from '../../types';
import { WorkstreamItem } from '../../components/workstream/types';
import { AGENCY_MODE, SITE_CONFIG } from '../../siteConfig';
import { DEFAULT_AVATAR } from '../../constants';

export interface UseWorkstreamListProps {
  orders?: Order[];
  usersList?: UserAccount[];
  gigs?: Gig[];
  messages?: Message[];
  currentUser?: UserAccount | null;
  impersonatedUser?: UserAccount | null;
}

/**
 * Hook responsible for hydrating workstream order items with related seller,
 * buyer, gig metadata, and the latest thread message details for the active user session.
 * Preserves preview reliability even when individual workstream messages are loaded/unloaded.
 */
export function useWorkstreamList({
  orders = [],
  usersList = [],
  gigs = [],
  messages = [],
  currentUser,
  impersonatedUser
}: UseWorkstreamListProps = {}) {
  const hydratedWorkstreamItems: WorkstreamItem[] = useMemo(() => {
    const activeUser = impersonatedUser || currentUser;
    const activeUid = activeUser?.id;
    if (!activeUid) return [];
    const staffViewer = isStaffRole(currentUser?.role);
    const relevantOrders = orders.filter(
      o =>
        o.buyerId === activeUid ||
        o.sellerId === activeUid ||
        (o as any).clientId === activeUid ||
        (o as any).freelancerId === activeUid ||
        staffViewer
    );

    return relevantOrders.map(o => {
      const sellerId = o.sellerId || (o as any).freelancerId;
      const buyerId = o.buyerId || (o as any).clientId;
      const matchedSeller =
        usersList.find(u => u.id === sellerId) ||
        (activeUser && activeUser.id === sellerId ? activeUser : undefined) ||
        (o as any).seller;
      const seller: UserAccount | undefined = matchedSeller || (AGENCY_MODE && sellerId
        ? ({
            id: sellerId,
            name: SITE_CONFIG.brandName,
            email: '',
            role: 'admin',
            avatar: DEFAULT_AVATAR,
            status: 'active'
          } as UserAccount)
        : undefined);
      const buyer =
        usersList.find(u => u.id === buyerId) ||
        (activeUser && activeUser.id === buyerId ? activeUser : undefined) ||
        (o as any).buyer;
      const gig = gigs.find(g => g.id === o.gigId);
      
      const orderMsgs = messages.filter(m => m.orderId === o.id);
      // 21: Sort by timestamp to ensure we pick the chronologically latest message
      const sortedMsgs = [...orderMsgs].sort(compareMessageTime);
      const lastMsg = sortedMsgs.length > 0 ? sortedMsgs[sortedMsgs.length - 1] : undefined;

      return {
        ...o,
        seller,
        buyer,
        gig,
        lastMessage: lastMsg ? lastMsg.text : (o as any).lastMessage,
        lastMessageTime: lastMsg ? lastMsg.timestamp : (o as any).lastMessageTime
      };
    });
  }, [orders, usersList, gigs, messages, currentUser, impersonatedUser]);

  return {
    hydratedWorkstreamItems,
    workstreams: hydratedWorkstreamItems
  };
}
