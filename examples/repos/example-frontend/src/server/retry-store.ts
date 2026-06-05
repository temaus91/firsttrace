type NotificationStatus = "SENDING" | "FAILED" | "SENT";

type NotificationRecord = {
  delivery_status: NotificationStatus;
  idempotency_key: string;
};

export const claimNotification = async (
  store: { insert(record: NotificationRecord): Promise<void>; find(key: string): Promise<NotificationRecord | null> },
  idempotencyKey: string,
) => {
  try {
    await store.insert({ delivery_status: "SENDING", idempotency_key: idempotencyKey });
    return { shouldSend: true };
  } catch (error) {
    const existing = await store.find(idempotencyKey);
    if (existing?.delivery_status === "FAILED") return { shouldSend: true };
    return { shouldSend: false };
  }
};
