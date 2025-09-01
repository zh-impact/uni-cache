CREATE TABLE "sources" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"base_url" text NOT NULL,
	"default_headers" jsonb,
	"default_query" jsonb,
	"rate_limit" jsonb,
	"cache_ttl_s" integer NOT NULL,
	"key_template" varchar(512) NOT NULL,
	"supports_pool" boolean NOT NULL
);
