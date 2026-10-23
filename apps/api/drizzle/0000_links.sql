CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_code" varchar(32) NOT NULL,
	"destination_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "links_short_code_format" CHECK ("links"."short_code" ~ '^[A-Za-z0-9_-]{3,32}$'),
	CONSTRAINT "links_destination_url_not_empty" CHECK (length(trim("links"."destination_url")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "links_short_code_unique" ON "links" USING btree ("short_code");--> statement-breakpoint
CREATE INDEX "links_created_at_idx" ON "links" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "links_expires_at_idx" ON "links" USING btree ("expires_at");