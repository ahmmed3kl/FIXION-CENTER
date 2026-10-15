import { PaymentRepository } from "./PaymentRepository";
import {
  PaymentOperationIdentity,
  PaymentSubmissionIdentity,
  resolvePaymentOperationIdentity,
} from "./paymentSubmissionIdentity";

export type PaymentActionRequest = PaymentSubmissionIdentity &
  Pick<
    Parameters<typeof PaymentRepository.recordPayment>[0],
    "paymentMethod" | "paymentDate"
  >;

export async function submitPaymentAction(
  request: PaymentActionRequest,
  previousIdentity: PaymentOperationIdentity | null,
  rememberIdentity?: (identity: PaymentOperationIdentity) => void,
): Promise<{ payment: Awaited<ReturnType<typeof PaymentRepository.recordPayment>>; identity: PaymentOperationIdentity }> {
  const identity = resolvePaymentOperationIdentity(request, previousIdentity);
  rememberIdentity?.(identity);

  const payment = await PaymentRepository.recordPayment({
    studentId: request.studentId,
    amount: request.amount,
    paymentType: request.paymentType,
    paymentMethod: request.paymentMethod,
    debtCycleId: request.debtCycleId,
    sessionId: request.sessionId,
    subscriptionId: request.subscriptionId,
    paymentDate: request.paymentDate,
    notes: request.notes,
    allowCreditBalance: request.allowCreditBalance,
    operationId: identity.operationId,
  });

  return { payment, identity };
}
