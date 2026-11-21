/** Original provider bytes and headers received from the trusted gateway. */
export type GitWebhookInput =
  | {
      readonly provider: 'github';
      readonly bindingId: string;
      readonly deliveryId: string;
      readonly event: string;
      readonly signature: string | undefined;
      readonly rawBody: Uint8Array;
    }
  | {
      readonly provider: 'gitlab';
      readonly bindingId: string;
      readonly deliveryId: string;
      readonly event: string;
      readonly signature: string | undefined;
      readonly timestamp: string;
      readonly currentUnixSeconds: number;
      readonly rawBody: Uint8Array;
    };
