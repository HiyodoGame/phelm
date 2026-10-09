import { z } from 'zod';
import { TimestampSchema } from './primitives.js';

/** Verbosity of user notifications. */
export const NotificationLevelSchema = z.enum(['all', 'important_only']);

/** Local time of day in 24-hour "HH:mm" form, for example "08:30". */
export const BriefingTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Per-user settings for briefings and notifications. */
export const UserSettingsSchema = z.object({
  /** Local time the daily briefing is delivered. Defaults to "08:30". */
  briefingTime: BriefingTimeSchema.default('08:30'),
  notificationLevel: NotificationLevelSchema,
});

/** A phelm user, identified by their GitHub login and optional Huawei account. */
export const UserSchema = z.object({
  id: z.string().min(1),
  githubLogin: z.string().min(1),
  /** Huawei cloud account id, when the user has linked one. */
  huaweiUid: z.string().min(1).optional(),
  settings: UserSettingsSchema,
});

/** Who recorded a decision entry. */
export const DecisionActorSchema = z.enum(['user', 'agent']);

/** Append-only audit entry recording who did what to which object, and when. */
export const DecisionLogSchema = z.object({
  id: z.string().min(1),
  actor: DecisionActorSchema,
  /** Reference to the acting user or agent, for example a User id or an AgentType. */
  actorRef: z.string().min(1),
  /** Short machine-readable action name, for example "suggestion.dismissed". */
  action: z.string().min(1),
  /** Reference to the affected object, for example a Suggestion id. */
  ref: z.string().min(1),
  ts: TimestampSchema,
});

/** Inferred type of {@link NotificationLevelSchema}. */
export type NotificationLevel = z.infer<typeof NotificationLevelSchema>;

/** Inferred type of {@link BriefingTimeSchema}; a string in "HH:mm" form. */
export type BriefingTime = z.infer<typeof BriefingTimeSchema>;

/** Inferred type of {@link UserSettingsSchema}. */
export type UserSettings = z.infer<typeof UserSettingsSchema>;

/** Inferred type of {@link UserSchema}. */
export type User = z.infer<typeof UserSchema>;

/** Inferred type of {@link DecisionActorSchema}. */
export type DecisionActor = z.infer<typeof DecisionActorSchema>;

/** Inferred type of {@link DecisionLogSchema}. */
export type DecisionLog = z.infer<typeof DecisionLogSchema>;
