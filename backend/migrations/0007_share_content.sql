-- Add content column to shares table for pre-fetched article content
ALTER TABLE shares ADD COLUMN content TEXT;
