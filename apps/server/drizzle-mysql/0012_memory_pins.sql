CREATE TABLE `memory_pin_changes` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`memory_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`pinned` boolean NOT NULL,
	`is_current` boolean NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `memory_pin_change_version` UNIQUE(`owner_id`,`memory_id`,`version`),
	CONSTRAINT `memory_pin_change_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
ALTER TABLE `memory_pin_changes` ADD CONSTRAINT `memory_pin_changes_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_pin_changes` ADD CONSTRAINT `memory_pin_changes_memory_id_memory_entries_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory_entries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `memory_pin_current_lookup` ON `memory_pin_changes` (`owner_id`,`memory_id`,`is_current`,`pinned`);