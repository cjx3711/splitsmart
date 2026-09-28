import { useNavigate } from "react-router-dom";

export function BulkAddButton({ groupId, friendId }: { groupId?: string; friendId?: string }) {
  const navigate = useNavigate();
  const query = new URLSearchParams();
  if (groupId) query.set("group", groupId);
  if (friendId) query.set("friend", friendId);
  return <button type="button" className="secondary inline" onClick={() => navigate(`/bulk-add${query.size ? `?${query}` : ""}`)}>Bulk add</button>;
}
