-- Hand-adjusted after generation, deliberately.
--
-- drizzle-kit emitted a bare `ADD COLUMN "client_op_id" text NOT NULL`, which
-- fails outright on any database that already has purchase rows — i.e. every
-- real one. Adding it nullable, backfilling, then tightening is the same end
-- state reached in an order that cannot abort a deploy.
--
-- The backfill uses each row's own `id`: those purchases predate the column and
-- their originating op is unknowable, so the only honest value is one that is
-- unique (satisfying the index) and matches no op (so no undo can ever claim to
-- retract a purchase it did not cause).
ALTER TABLE "purchases" ADD COLUMN "client_op_id" text;--> statement-breakpoint
UPDATE "purchases" SET "client_op_id" = "id" WHERE "client_op_id" IS NULL;--> statement-breakpoint
ALTER TABLE "purchases" ALTER COLUMN "client_op_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_client_op_id_uq" ON "purchases" USING btree ("client_op_id");
