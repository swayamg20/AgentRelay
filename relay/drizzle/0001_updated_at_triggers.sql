-- Auto-update updated_at on row modification (lld.md §2 preamble).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agents_set_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER agent_cards_set_updated_at
  BEFORE UPDATE ON agent_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER handoffs_set_updated_at
  BEFORE UPDATE ON handoffs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
