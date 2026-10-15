export interface PaymentSubmissionIdentity {
  centerId: string;
  studentId: string;
  amount: number;
  paymentType: "monthly" | "partial" | "session";
  debtCycleId?: string;
  sessionId?: string;
  subscriptionId?: string;
  notes?: string;
  allowCreditBalance?: boolean;
}

export interface PaymentOperationIdentity {
  signature: string;
  operationId: string;
}

export function resolvePaymentOperationIdentity(
  payment: PaymentSubmissionIdentity,
  previous: PaymentOperationIdentity | null,
): PaymentOperationIdentity {
  const signature = JSON.stringify([
    payment.centerId,
    payment.studentId,
    payment.amount,
    payment.paymentType,
    payment.debtCycleId || "",
    payment.sessionId || "",
    payment.subscriptionId || "",
    payment.notes || "",
    Boolean(payment.allowCreditBalance),
  ]);
  if (previous?.signature === signature) return previous;

  return {
    signature,
    operationId: `op-pay-ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
}
