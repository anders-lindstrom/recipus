ALTER TABLE "contributions" ADD COLUMN "amount_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "amount_updated_by" text;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "note_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "note_updated_by" text;