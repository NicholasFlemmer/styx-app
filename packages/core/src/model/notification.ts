import { z } from 'zod';
import { askIdSchema, projectIdSchema, sessionIdSchema, timestampSchema } from './common';

export const notificationKindSchema = z.enum(['needs-you', 'grant-result', 'error-banner', 'info']);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationStateSchema = z.enum(['shown', 'later', 'acted', 'dismissed', 'resolved']);
export type NotificationState = z.infer<typeof notificationStateSchema>;

export const notificationSchema = z.object({
  id: z.string().min(1),
  kind: notificationKindSchema,
  sessionId: sessionIdSchema.nullable(),
  askId: askIdSchema.nullable(),
  projectId: projectIdSchema.nullable(),
  title: z.string(),
  body: z.string(),
  meta: z.string().nullable(),
  osDelivered: z.boolean(),
  state: notificationStateSchema,
  /** Persistent banners dedupe on this key (e.g. "auth-expired:<targetId>"). */
  bannerKey: z.string().nullable(),
  createdAt: timestampSchema,
  resolvedAt: timestampSchema.nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;
