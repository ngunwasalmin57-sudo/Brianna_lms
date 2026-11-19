// Who can do what. The backend and the frontend read this same list.
// Keep this file identical in both projects.

export type Role =
  | "loan_officer"
  | "supervisor"
  | "committee"
  | "finance"
  | "management"
  | "director"
  | "ceo"
  | "admin"
  | "customer";

export const roleNames: Record<Role, string> = {
  loan_officer: "Loan Officer",
  supervisor: "Supervisor",
  committee: "Credit Committee",
  finance: "Finance Officer",
  management: "Manager",
  director: "Company Director",
  ceo: "Chief Executive Officer (Owner)",
  admin: "System Admin",
  customer: "Customer",
};

export type Permission =
  | "dashboard.view"
  | "dashboard.portfolio"   // charts and portfolio figures
  | "dashboard.dueList"     // repayments due and overdue table
  | "customers.view"
  | "customers.add"
  | "groups.manage"
  | "assessment.do"
  | "applications.view"
  | "approvals.view"
  | "customer.requests"
  | "disbursement.view"
  | "repayments.view"
  | "reports.view"
  | "settings.view"
  | "account.settings"
  | "manager.view";

const everyone: Role[] = ["loan_officer", "supervisor", "committee", "finance", "management", "director", "ceo", "admin"];
const allAccounts: Role[] = [...everyone, "customer"];

const grants: Record<Permission, Role[]> = {
  "dashboard.view": ["loan_officer", "supervisor", "committee", "finance", "director", "ceo", "admin"],
  "dashboard.portfolio": ["loan_officer", "supervisor", "committee", "finance", "director", "ceo"],
  "dashboard.dueList": ["loan_officer", "supervisor", "finance", "director", "ceo"],
  "customers.view": ["loan_officer", "supervisor", "finance", "director", "ceo"],
  "customers.add": ["loan_officer", "director", "ceo"],
  "groups.manage": ["loan_officer", "director", "ceo"],
  "assessment.do": ["loan_officer", "director", "ceo"],
  "applications.view": ["loan_officer", "supervisor", "director", "ceo"],
  "customer.requests": ["loan_officer", "supervisor", "director", "ceo"],
  "approvals.view": ["supervisor", "committee", "director", "ceo"],
  "disbursement.view": ["finance", "supervisor", "director", "ceo"],
  "repayments.view": ["loan_officer", "finance", "supervisor", "director", "ceo"],
  "reports.view": ["loan_officer", "supervisor", "director", "ceo"],
  "settings.view": ["admin"],
  "account.settings": allAccounts,
  "manager.view": ["management", "director", "ceo"],
};

export function can(role: Role | undefined, permission: Permission): boolean {
  return role !== undefined && grants[permission].includes(role);
}
