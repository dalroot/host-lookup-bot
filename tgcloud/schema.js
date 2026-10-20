import { table, integer, text, boolean, sql } from 'sdk/db';

export const users = table('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tgId: integer('tg_id').unique(),
  username: text('username'),
  firstName: text('first_name'),
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const fsubChannels = table('fsub_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  title: text('title').default('Official Channel'),
  inviteLink: text('invite_link').notNull(),
  isActive: boolean('is_active').default(true),
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const botSettings = table('bot_settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

