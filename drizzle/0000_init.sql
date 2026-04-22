CREATE TABLE IF NOT EXISTS "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"taxonomy_id" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "taxonomies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relationships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_taxonomy_id_taxonomies_id_fk" FOREIGN KEY ("taxonomy_id") REFERENCES "public"."taxonomies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_taxonomy_id_idx" ON "entities" USING btree ("taxonomy_id") WHERE archived = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_attributes_gin_idx" ON "entities" USING gin ("attributes") WHERE archived = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "taxonomies_relationships_gin_idx" ON "taxonomies" USING gin ("relationships" jsonb_path_ops);