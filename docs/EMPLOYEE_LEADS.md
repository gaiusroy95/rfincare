# Employee leads tab

## Portal

Employees with the `leads` module (or default full access) see a **Leads** tab in the Employee Portal showing enquiries assigned to them.

## API

### List assigned leads

```
GET /leads?assignedTo=me
Authorization: Bearer <employee token>
```

Returns up to 200 `marketing_leads` where `assigned_to` equals the current user. Admins calling `assignedTo=me` receive all leads (no filter).

### Update lead status (employee)

```
PATCH /leads/:id/status
{ "status": "contacted" | "in_progress" | "converted" | "closed" }
```

Allowed when the employee is the assignee. Admins can update any lead.

Assign and CSV export remain admin-only (`PATCH /leads/:id/assign`, `GET /leads/export.csv`).

## Access control

Add `leads` to `employee_access_controls` for scoped employees. Module label: **Marketing Leads**.

## Manual verification

1. Admin assigns a lead to `employee@rfincare.com` in Admin → Leads.
2. Employee logs in → Employee Portal → Leads tab.
3. Only assigned leads appear; status dropdown updates work.
