import ActivityFeedClient from "./ActivityFeedClient";

// AGENT.md §3.3: SPA static export — no force-dynamic.
export default function ActivityPage() {
  return <ActivityFeedClient />;
}
