-- 扩展由版本化迁移创建，兼容已有 F01 数据卷。
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "companions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"runtime_epoch" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"initial_snapshot" jsonb NOT NULL,
	"current_persona_version_id" uuid,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companions_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "companions_request_unique" UNIQUE("owner_id","request_id"),
	CONSTRAINT "companions_versions_positive" CHECK ("companions"."runtime_epoch" > 0 AND "companions"."version" > 0),
	CONSTRAINT "companions_name_length" CHECK (char_length("companions"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"companion_id" uuid,
	"runtime_epoch" integer,
	"joined_sequence" integer DEFAULT 1 NOT NULL,
	"left_sequence" integer,
	"permission_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "conversation_members_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "conversation_members_conversation_id_unique" UNIQUE("owner_id","conversation_id","id"),
	CONSTRAINT "conversation_members_user_unique" UNIQUE("owner_id","conversation_id","user_id"),
	CONSTRAINT "conversation_members_companion_unique" UNIQUE("owner_id","conversation_id","companion_id","runtime_epoch"),
	CONSTRAINT "conversation_members_identity_valid" CHECK (("conversation_members"."kind" = 'user' AND "conversation_members"."user_id" = "conversation_members"."owner_id" AND "conversation_members"."user_id" IS NOT NULL AND "conversation_members"."companion_id" IS NULL AND "conversation_members"."runtime_epoch" IS NULL) OR ("conversation_members"."kind" = 'companion' AND "conversation_members"."user_id" IS NULL AND "conversation_members"."companion_id" IS NOT NULL AND "conversation_members"."runtime_epoch" IS NOT NULL AND "conversation_members"."runtime_epoch" > 0)),
	CONSTRAINT "conversation_members_range_valid" CHECK ("conversation_members"."joined_sequence" > 0 AND ("conversation_members"."left_sequence" IS NULL OR "conversation_members"."left_sequence" >= "conversation_members"."joined_sequence") AND "conversation_members"."permission_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "conversations_request_unique" UNIQUE("owner_id","request_id"),
	CONSTRAINT "conversations_kind_valid" CHECK ("conversations"."kind" IN ('private', 'group')),
	CONSTRAINT "conversations_versions_positive" CHECK ("conversations"."version" > 0 AND "conversations"."last_sequence" >= 0),
	CONSTRAINT "conversations_title_length" CHECK (char_length("conversations"."title") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "message_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"source_content_version" integer NOT NULL,
	"relation" text NOT NULL,
	CONSTRAINT "message_sources_reference_unique" UNIQUE("owner_id","message_id","source_message_id","source_content_version","relation"),
	CONSTRAINT "message_sources_relation_valid" CHECK ("message_sources"."relation" IN ('reference', 'report')),
	CONSTRAINT "message_sources_not_self" CHECK ("message_sources"."message_id" <> "message_sources"."source_message_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"speaker_membership_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"content_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"sequence" integer,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"epistemic_kind" text DEFAULT 'statement' NOT NULL,
	"reality" text DEFAULT 'unspecified' NOT NULL,
	"source_kind" text NOT NULL,
	"reply_to_message_id" uuid,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"publish_request_id" uuid,
	"publish_fingerprint" text,
	CONSTRAINT "messages_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "messages_conversation_id_unique" UNIQUE("owner_id","conversation_id","id"),
	CONSTRAINT "messages_content_version_unique" UNIQUE("owner_id","id","content_version"),
	CONSTRAINT "messages_conversation_content_unique" UNIQUE("owner_id","conversation_id","id","content_version"),
	CONSTRAINT "messages_sequence_unique" UNIQUE("owner_id","conversation_id","sequence"),
	CONSTRAINT "messages_request_unique" UNIQUE("owner_id","conversation_id","request_id"),
	CONSTRAINT "messages_publish_request_unique" UNIQUE("owner_id","conversation_id","publish_request_id"),
	CONSTRAINT "messages_versions_positive" CHECK ("messages"."schema_version" > 0 AND "messages"."content_version" > 0 AND "messages"."revision" > 0),
	CONSTRAINT "messages_text_length" CHECK (char_length("messages"."text") BETWEEN 1 AND 4000),
	CONSTRAINT "messages_publication_valid" CHECK (("messages"."state" = 'draft' AND "messages"."sequence" IS NULL AND "messages"."published_at" IS NULL AND "messages"."publish_request_id" IS NULL AND "messages"."publish_fingerprint" IS NULL) OR ("messages"."state" = 'published' AND "messages"."sequence" IS NOT NULL AND "messages"."sequence" > 0 AND "messages"."published_at" IS NOT NULL AND "messages"."publish_request_id" IS NOT NULL AND "messages"."publish_fingerprint" IS NOT NULL)),
	CONSTRAINT "messages_validity_ordered" CHECK ("messages"."valid_from" IS NULL OR "messages"."valid_until" IS NULL OR "messages"."valid_until" >= "messages"."valid_from"),
	CONSTRAINT "messages_epistemic_kind_valid" CHECK ("messages"."epistemic_kind" IN ('statement', 'report', 'inference', 'setting')),
	CONSTRAINT "messages_reality_valid" CHECK ("messages"."reality" IN ('unspecified', 'real', 'fictional')),
	CONSTRAINT "messages_source_kind_valid" CHECK ("messages"."source_kind" IN ('user_input', 'admin_companion_input'))
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_key" text DEFAULT 'local' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owners_deployment_key_unique" UNIQUE("deployment_key")
);
--> statement-breakpoint
CREATE TABLE "persona_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"companion_id" uuid NOT NULL,
	"runtime_epoch" integer NOT NULL,
	"version" integer NOT NULL,
	"profile_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_versions_owner_companion_id_unique" UNIQUE("owner_id","companion_id","id"),
	CONSTRAINT "persona_versions_number_unique" UNIQUE("owner_id","companion_id","runtime_epoch","version"),
	CONSTRAINT "persona_versions_positive" CHECK ("persona_versions"."runtime_epoch" > 0 AND "persona_versions"."version" > 0),
	CONSTRAINT "persona_versions_profile_length" CHECK (char_length("persona_versions"."profile_text") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "processing_ranges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"companion_id" uuid NOT NULL,
	"runtime_epoch" integer NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"content_version" integer NOT NULL,
	"start_sequence" integer NOT NULL,
	"end_sequence" integer NOT NULL,
	"stage" text DEFAULT 'memory_extraction' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_ranges_instance_message_unique" UNIQUE("owner_id","companion_id","runtime_epoch","message_id","content_version","stage"),
	CONSTRAINT "processing_ranges_range_valid" CHECK ("processing_ranges"."runtime_epoch" > 0 AND "processing_ranges"."start_sequence" > 0 AND "processing_ranges"."end_sequence" >= "processing_ranges"."start_sequence"),
	CONSTRAINT "processing_ranges_stage_valid" CHECK ("processing_ranges"."stage" = 'memory_extraction' AND "processing_ranges"."status" = 'pending')
);
--> statement-breakpoint
CREATE TABLE "read_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"companion_id" uuid NOT NULL,
	"runtime_epoch" integer NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"content_version" integer NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	CONSTRAINT "read_receipts_instance_message_unique" UNIQUE("owner_id","companion_id","runtime_epoch","message_id","content_version"),
	CONSTRAINT "read_receipts_range_valid" CHECK ("read_receipts"."runtime_epoch" > 0 AND "read_receipts"."start_offset" >= 0 AND "read_receipts"."end_offset" >= "read_receipts"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "receive_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"companion_id" uuid NOT NULL,
	"runtime_epoch" integer NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"messages" jsonb NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receive_batches_request_unique" UNIQUE("owner_id","companion_id","runtime_epoch","conversation_id","request_id"),
	CONSTRAINT "receive_batches_epoch_positive" CHECK ("receive_batches"."runtime_epoch" > 0),
	CONSTRAINT "receive_batches_messages_array" CHECK (jsonb_typeof("receive_batches"."messages") = 'array')
);
--> statement-breakpoint
CREATE TABLE "visibility_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"start_sequence" integer NOT NULL,
	"end_sequence" integer,
	"kind" text NOT NULL,
	"permission_version" integer NOT NULL,
	CONSTRAINT "visibility_grants_range_unique" UNIQUE("owner_id","membership_id","kind","start_sequence","permission_version"),
	CONSTRAINT "visibility_grants_kind_valid" CHECK ("visibility_grants"."kind" IN ('membership', 'history')),
	CONSTRAINT "visibility_grants_range_valid" CHECK ("visibility_grants"."start_sequence" > 0 AND ("visibility_grants"."end_sequence" IS NULL OR "visibility_grants"."end_sequence" >= "visibility_grants"."start_sequence") AND "visibility_grants"."permission_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_current_persona_fk" FOREIGN KEY ("owner_id","id","current_persona_version_id") REFERENCES "public"."persona_versions"("owner_id","companion_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_owner_id_conversation_id_conversations_owner_id_id_fk" FOREIGN KEY ("owner_id","conversation_id") REFERENCES "public"."conversations"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_owner_id_companion_id_companions_owner_id_id_fk" FOREIGN KEY ("owner_id","companion_id") REFERENCES "public"."companions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_sources" ADD CONSTRAINT "message_sources_owner_id_message_id_messages_owner_id_id_fk" FOREIGN KEY ("owner_id","message_id") REFERENCES "public"."messages"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_sources" ADD CONSTRAINT "message_sources_owner_id_source_message_id_source_content_version_messages_owner_id_id_content_version_fk" FOREIGN KEY ("owner_id","source_message_id","source_content_version") REFERENCES "public"."messages"("owner_id","id","content_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_conversation_id_conversations_owner_id_id_fk" FOREIGN KEY ("owner_id","conversation_id") REFERENCES "public"."conversations"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_conversation_id_speaker_membership_id_conversation_members_owner_id_conversation_id_id_fk" FOREIGN KEY ("owner_id","conversation_id","speaker_membership_id") REFERENCES "public"."conversation_members"("owner_id","conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_id_conversation_id_reply_to_message_id_messages_owner_id_conversation_id_id_fk" FOREIGN KEY ("owner_id","conversation_id","reply_to_message_id") REFERENCES "public"."messages"("owner_id","conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_versions" ADD CONSTRAINT "persona_versions_owner_id_companion_id_companions_owner_id_id_fk" FOREIGN KEY ("owner_id","companion_id") REFERENCES "public"."companions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_ranges" ADD CONSTRAINT "processing_ranges_owner_id_companion_id_companions_owner_id_id_fk" FOREIGN KEY ("owner_id","companion_id") REFERENCES "public"."companions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_ranges" ADD CONSTRAINT "processing_ranges_owner_id_conversation_id_message_id_content_version_messages_owner_id_conversation_id_id_content_version_fk" FOREIGN KEY ("owner_id","conversation_id","message_id","content_version") REFERENCES "public"."messages"("owner_id","conversation_id","id","content_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_owner_id_companion_id_companions_owner_id_id_fk" FOREIGN KEY ("owner_id","companion_id") REFERENCES "public"."companions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_owner_id_conversation_id_message_id_content_version_messages_owner_id_conversation_id_id_content_version_fk" FOREIGN KEY ("owner_id","conversation_id","message_id","content_version") REFERENCES "public"."messages"("owner_id","conversation_id","id","content_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receive_batches" ADD CONSTRAINT "receive_batches_owner_id_companion_id_companions_owner_id_id_fk" FOREIGN KEY ("owner_id","companion_id") REFERENCES "public"."companions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receive_batches" ADD CONSTRAINT "receive_batches_owner_id_conversation_id_conversations_owner_id_id_fk" FOREIGN KEY ("owner_id","conversation_id") REFERENCES "public"."conversations"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_grants" ADD CONSTRAINT "visibility_grants_owner_id_membership_id_conversation_members_owner_id_id_fk" FOREIGN KEY ("owner_id","membership_id") REFERENCES "public"."conversation_members"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processing_ranges_conversation_sequence_idx" ON "processing_ranges" USING btree ("owner_id","companion_id","runtime_epoch","conversation_id","start_sequence");
--> statement-breakpoint
-- 单部署身份只创建一次，不接受请求体提供的管理者身份。
INSERT INTO "owners" ("deployment_key") VALUES ('local') ON CONFLICT ("deployment_key") DO NOTHING;
