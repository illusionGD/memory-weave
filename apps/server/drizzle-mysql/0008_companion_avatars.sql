ALTER TABLE `companions` ADD `avatar` json;--> statement-breakpoint
ALTER TABLE `companions` ADD `avatar_version` int DEFAULT 0 NOT NULL;