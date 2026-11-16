import { ConsultationMessage } from '../types/domain';

/**
 * Returns true ONLY for legitimately pharmacist-authored consultation replies.
 * Prevents patient-origin messages (even if tampered with approvedByPharmacist: true)
 * from rendering pharmacist approval indicators in the UI.
 */
export function isVerifiedPharmacistApproval(msg: ConsultationMessage): boolean {
  return (
    msg.senderType === 'pharmacist' &&
    typeof msg.senderStaffId === 'string' &&
    msg.senderStaffId.trim().length > 0 &&
    msg.approvedByPharmacist === true
  );
}
