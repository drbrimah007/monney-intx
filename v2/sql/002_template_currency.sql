-- Migration 002: Add currency column to templates
-- Run this in the Supabase SQL editor

ALTER TABLE templates ADD COLUMN IF NOT EXISTS currency text DEFAULT '';
