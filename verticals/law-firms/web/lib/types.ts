export interface MatterSummary {
  id: string;
  number: string;
  description: string;
  status: string;
  opened_on: string;
  client_name: string;
  fee_earner: string;
  client_balance: string;
  office_balance: string;
  wip: string;
}

export interface FeeEarner {
  id: string;
  name: string;
  initials: string;
  hourly_rate: string;
}

export interface LawClient {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  client_type: "individual" | "organisation";
  cdd_status: "pending" | "complete";
  matters: string;
  client_balance: string;
}

export interface LedgerRow {
  id: string;
  date: string;
  kind: "receipt" | "payment" | "transfer" | "fee_note";
  amount: string;
  balance: string;
  counterparty: string | null;
  reference: string | null;
  journal_number: string;
  fee_note_number: string | null;
}

export interface TimeEntry {
  id: string;
  date: string;
  minutes: number;
  units: number;
  rate: string;
  value: string;
  narrative: string;
  fee_earner: string;
  fee_note_number: string | null;
}

export interface FeeNote {
  id: string;
  number: string;
  date: string;
  net: string;
  vat: string;
  total: string;
  amount_settled: string;
  outstanding: string;
  maxTransfer: string;
}

export interface MatterDetail {
  matter: {
    id: string; number: string; description: string; status: string; opened_on: string;
    client_name: string; client_type: string; cdd_status: string; fee_earner_name: string; fee_earner: string; hourly_rate: string;
  };
  clientBalance: string;
  officeBalance: string;
  clientLedger: LedgerRow[];
  officeLedger: LedgerRow[];
  time: TimeEntry[];
  feeNotes: FeeNote[];
}
