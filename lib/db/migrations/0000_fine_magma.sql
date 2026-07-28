-- F1 (KIM-417): pgcrypto must be installed before any table default calls
-- gen_random_uuid() below. Originally this extension was only created in
-- 0001_exclusion_constraints.sql (needed there for btree_gist), which left a
-- window where applying this migration to a fresh database with no pgcrypto
-- pre-installed would fail on the very first CREATE TABLE. Moved here so it
-- runs before any gen_random_uuid() usage. See Linear KIM-417.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'cancelled', 'completed', 'pending', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."table_surface" AS ENUM('top', 'bottom');--> statement-breakpoint
CREATE TYPE "public"."table_type" AS ENUM('small', 'large', 'removable_top');--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_number" varchar(20) NOT NULL,
	"email" text,
	"role" "role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"no_show_count" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"auth_email" text NOT NULL,
	"full_name" text,
	"active_from" timestamp with time zone,
	"psw_changed" timestamp with time zone,
	"phone" text,
	"password_hash" text,
	CONSTRAINT "profiles_member_number_unique" UNIQUE("member_number")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"table_count" integer DEFAULT 0 NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "table_type" DEFAULT 'small' NOT NULL,
	"qr_code" text,
	"pos_x" integer,
	"pos_y" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"qr_code_inf" text
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"surface" "table_surface",
	"status" "reservation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "reservation_times_valid" CHECK ("reservations"."end_time" > "reservations"."start_time")
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation_equipment" (
	"reservation_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	CONSTRAINT "reservation_equipment_reservation_id_equipment_id_pk" PRIMARY KEY("reservation_id","equipment_id")
);
--> statement-breakpoint
CREATE TABLE "room_default_equipment" (
	"room_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	CONSTRAINT "room_default_equipment_room_id_equipment_id_pk" PRIMARY KEY("room_id","equipment_id")
);
--> statement-breakpoint
CREATE TABLE "event_equipment" (
	"event_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "event_equipment_event_id_equipment_id_pk" PRIMARY KEY("event_id","equipment_id"),
	CONSTRAINT "event_equipment_quantity_positive" CHECK ("event_equipment"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "event_room_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"table_id" uuid,
	CONSTRAINT "event_room_blocks_valid_time_range" CHECK ("event_room_blocks"."end_time" > "event_room_blocks"."start_time")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title_es" text,
	"title_en" text,
	"blurb_es" text,
	"blurb_en" text,
	"description_es" text,
	"description_en" text,
	"date_kind" text DEFAULT 'single' NOT NULL,
	"end_date" date,
	"recurrence_label_es" text,
	"recurrence_label_en" text,
	"image_url" text,
	"link_url" text,
	"category_es" text,
	"category_en" text,
	CONSTRAINT "events_valid_time_range" CHECK ("events"."end_time" > "events"."start_time"),
	CONSTRAINT "events_valid_date_kind" CHECK ("events"."date_kind" IN ('single', 'range', 'recurring')),
	CONSTRAINT "events_valid_end_date" CHECK ("events"."end_date" IS NULL OR "events"."end_date" >= "events"."date"),
	CONSTRAINT "events_bilingual_titles_paired" CHECK (("events"."title_es" IS NULL) = ("events"."title_en" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "saved_game_attendances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"saved_game_id" uuid NOT NULL,
	"play_reservation_id" uuid NOT NULL,
	"attended_on" date NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_game_attendances_play_reservation_id_unique" UNIQUE("play_reservation_id")
);
--> statement-breakpoint
CREATE TABLE "saved_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"attendance_count" integer DEFAULT 0 NOT NULL,
	"renewed_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_games_renewed_from_id_unique" UNIQUE("renewed_from_id"),
	CONSTRAINT "saved_games_valid_status" CHECK ("saved_games"."status" IN ('active', 'cancelled', 'completed')),
	CONSTRAINT "saved_games_valid_dates" CHECK ("saved_games"."end_date" >= "saved_games"."start_date"),
	CONSTRAINT "saved_games_max_duration" CHECK ("saved_games"."end_date" < ("saved_games"."start_date" + interval '3 months')),
	CONSTRAINT "saved_games_attendance_nonnegative" CHECK ("saved_games"."attendance_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "activation_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_tokens_profile_id_unique" UNIQUE("profile_id"),
	CONSTRAINT "activation_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"img_url" text NOT NULL,
	"link_url" text,
	"desc_es" text,
	"desc_en" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"category_es" text NOT NULL,
	"category_en" text NOT NULL,
	"players" text NOT NULL,
	"play_time" text NOT NULL,
	"weight" numeric(2, 1) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"img_url" text
);
--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_equipment" ADD CONSTRAINT "reservation_equipment_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_equipment" ADD CONSTRAINT "reservation_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_default_equipment" ADD CONSTRAINT "room_default_equipment_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_default_equipment" ADD CONSTRAINT "room_default_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_equipment" ADD CONSTRAINT "event_equipment_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_equipment" ADD CONSTRAINT "event_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_room_blocks" ADD CONSTRAINT "event_room_blocks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_room_blocks" ADD CONSTRAINT "event_room_blocks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_room_blocks" ADD CONSTRAINT "event_room_blocks_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_game_attendances" ADD CONSTRAINT "saved_game_attendances_saved_game_id_saved_games_id_fk" FOREIGN KEY ("saved_game_id") REFERENCES "public"."saved_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_game_attendances" ADD CONSTRAINT "saved_game_attendances_play_reservation_id_reservations_id_fk" FOREIGN KEY ("play_reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_games" ADD CONSTRAINT "saved_games_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_games" ADD CONSTRAINT "saved_games_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_games" ADD CONSTRAINT "saved_games_renewed_from_id_saved_games_id_fk" FOREIGN KEY ("renewed_from_id") REFERENCES "public"."saved_games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_tokens" ADD CONSTRAINT "activation_tokens_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_tokens" ADD CONSTRAINT "activation_tokens_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_auth_email_key" ON "profiles" USING btree ("auth_email");--> statement-breakpoint
CREATE INDEX "tables_room_id_idx" ON "tables" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "reservations_date_idx" ON "reservations" USING btree ("date");--> statement-breakpoint
CREATE INDEX "reservations_table_date_idx" ON "reservations" USING btree ("table_id","date");--> statement-breakpoint
CREATE INDEX "reservations_user_id_idx" ON "reservations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reservations_activation_lookup_idx" ON "reservations" USING btree ("table_id","date","user_id","status");--> statement-breakpoint
CREATE INDEX "reservations_pending_date_idx" ON "reservations" USING btree ("date","start_time") WHERE "reservations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "reservations_pending_no_show_idx" ON "reservations" USING btree ("date","end_time") WHERE "reservations"."status" = 'pending' AND "reservations"."activated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservations_user_date_status_idx" ON "reservations" USING btree ("user_id","date","status") WHERE "reservations"."status" IN ('pending', 'active');--> statement-breakpoint
CREATE INDEX "reservation_equipment_equipment_id_idx" ON "reservation_equipment" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "room_default_equipment_equipment_id_idx" ON "room_default_equipment" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "event_room_blocks_event_id_idx" ON "event_room_blocks" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_room_blocks_room_id_idx" ON "event_room_blocks" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_room_blocks_unique_block" ON "event_room_blocks" USING btree ("event_id","room_id","date","start_time","end_time");--> statement-breakpoint
CREATE INDEX "events_date_idx" ON "events" USING btree ("date");--> statement-breakpoint
CREATE INDEX "events_created_by_idx" ON "events" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "saved_game_attendances_saved_game_id_idx" ON "saved_game_attendances" USING btree ("saved_game_id");--> statement-breakpoint
CREATE INDEX "saved_games_user_dates_idx" ON "saved_games" USING btree ("user_id","start_date","end_date") WHERE "saved_games"."status" = 'active';--> statement-breakpoint
CREATE INDEX "saved_games_table_dates_idx" ON "saved_games" USING btree ("table_id","start_date","end_date") WHERE "saved_games"."status" = 'active';--> statement-breakpoint
CREATE INDEX "activation_tokens_created_by_idx" ON "activation_tokens" USING btree ("created_by");
