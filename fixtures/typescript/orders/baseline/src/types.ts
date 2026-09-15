export type Priority = "standard" | "expedited";

export interface CreateOrderBody {
  customer: { id: string; address: { city: string } };
  items: Array<{ sku: string; quantity: number }>;
  priority?: Priority;
}

export interface OrderView {
  id: string;
  state: "pending" | "confirmed";
}
