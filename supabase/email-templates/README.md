# EstimateAce auth email templates

Confirmation emails still come from **Supabase Auth** (`noreply@mail.app.supabase.io`) with Supabase branding until custom SMTP and these templates are set in the **Supabase dashboard**. This repository does not change production Auth config.

Paste the HTML here into Authentication → Email Templates after SMTP is on:

| Dashboard template | File | Suggested subject |
| --- | --- | --- |
| Confirm signup | `confirmation.html` | Confirm your EstimateAce account |
| Reset password | `recovery.html` | Reset your EstimateAce password |

Do not use `{{ .ConfirmationURL }}` in these templates. That placeholder expands to a
`*.supabase.co` verify URL, and mailboxes (Outlook especially) treat a password or
confirm button that leaves estimateace.com as phishing. Use app-domain links instead:

- Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`
- Reset password: `{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery`

`{{ .Email }}` and `{{ .TokenHash }}` are filled in by Supabase. Site URL in
Authentication → URL configuration must be `https://app.estimateace.com`.

## Custom SMTP (Resend)

In the Supabase dashboard: **Project Settings → Authentication → SMTP Settings** (or **Authentication → Emails → SMTP**).

| Setting | Value |
| --- | --- |
| Enable custom SMTP | On |
| Sender name | EstimateAce |
| Sender email | `noreply@send.estimateace.com` |
| SMTP host | `smtp.resend.com` |
| SMTP port | `465` |
| SMTP username | `resend` |
| SMTP password | a Resend API key (`re_…`) — preferably a dedicated sending key, or the same `RESEND_API_KEY` already used by the app |
| Minimum interval | leave the default (or 60 seconds) |

**Sender address:** `send.estimateace.com` is the Resend/SES sending subdomain (SPF on that host). `EstimateAce <noreply@send.estimateace.com>` is the recommended From. The app already sends other mail as `EstimateAce <notifications@estimateace.com>`; only use that root address for Auth if the root domain is verified in Resend **and** its SPF includes Resend/SES. If Resend rejects the sender, switch to a verified domain in the Resend dashboard.

After saving SMTP, send a test confirmation to yourself and confirm the From line is `EstimateAce <noreply@send.estimateace.com>` with no “Powered by Supabase” footer.

## Management API / MCP connector

The Supabase MCP connector in this workspace **cannot** set Auth SMTP or email templates (no such tool). Do not apply this from the connector.

The Supabase Management API can, with a personal access token, via:

```
PATCH https://api.supabase.com/v1/projects/{project_ref}/config/auth
```

Relevant fields (do not send these against production without an explicit go-ahead):

- `smtp_admin_email` — sender email (`noreply@send.estimateace.com`)
- `smtp_host` — `smtp.resend.com`
- `smtp_port` — `465`
- `smtp_user` — `resend`
- `smtp_pass` — Resend API key
- `smtp_sender_name` — `EstimateAce`
- `mailer_subjects_confirmation` / `mailer_templates_confirmation_content`
- `mailer_subjects_recovery` / `mailer_templates_recovery_content`

Leave production Auth config unchanged until these values are reviewed and applied in the dashboard (or via the Management API with approval).
