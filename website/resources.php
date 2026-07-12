<?php
$page_title = 'Resources | EstimateAce Contractor Guides';
$page_description = 'Guides, playbooks, and resources for contractors using EstimateAce.';
include __DIR__ . '/includes/header.php';
$app_url = 'https://app.estimateace.com';
?>

<section class="page-hero">
  <div class="container">
    <span class="eyebrow">Resources</span>
    <h1>Help your business run smoother</h1>
    <p class="lead">Practical guides for estimating, pricing, scheduling, and getting paid—written for tradespeople, not consultants.</p>
  </div>
</section>

<section>
  <div class="container resource-list">
    <article>
      <span class="tag">Getting started</span>
      <h3>Your first 30 minutes in EstimateAce</h3>
      <p>Set up company profile, payment links, a Quick Line for your most common service, and send your first estimate from your phone.</p>
    </article>
    <article>
      <span class="tag">Estimating</span>
      <h3>Estimates customers approve faster</h3>
      <p>Use clear scope language, attach site photos, set deposit expectations upfront, and send the preview while you're still on-site.</p>
    </article>
    <article>
      <span class="tag">AI</span>
      <h3>AI pricing without giving away margin</h3>
      <p>Let AI build internal materials and labor lists. Toggle client visibility. Always review before sending.</p>
    </article>
    <article>
      <span class="tag">Scheduling</span>
      <h3>Reduce no-shows</h3>
      <p>Schedule from the estimate, confirm client email and phone, enable SMS confirmations, and turn on daily contractor reminders.</p>
    </article>
    <article>
      <span class="tag">Operations</span>
      <h3>Invoice → paid → archive</h3>
      <p>Close the loop on every job. Export CSV monthly for your bookkeeper.</p>
    </article>
  </div>
</section>

<section class="soft">
  <div class="container cards-3">
    <article class="card">
      <img src="https://images.unsplash.com/photo-1434626881859-194d67b2b86f?auto=format&fit=crop&w=800&q=80" alt="Checklist" />
      <h3>Estimate checklist</h3>
      <p>Address · Contacts · Line items · Photos · Terms · Deposit · Send preview · Schedule if needed</p>
    </article>
    <article class="card">
      <img src="https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=800&q=80" alt="Training" />
      <h3>Crew onboarding</h3>
      <p>Issue crew logins, train photo uploads per job, and keep client-facing sends on the main account until ready.</p>
    </article>
    <article class="card">
      <img src="https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=800&q=80" alt="Dashboard" />
      <h3>Weekly owner ritual</h3>
      <p>Monday: outstanding invoices. Wednesday: next 14 days on calendar. Friday: archive paid jobs and export backup.</p>
    </article>
  </div>
</section>

<section class="soft" id="privacy">
  <div class="container cards-2">
    <article class="card" id="terms">
      <h3>Terms of use</h3>
      <p>EstimateAce provides software for contractors. You are responsible for pricing accuracy and compliance. Payment processing is via third parties you connect.</p>
    </article>
    <article class="card">
      <h3>Privacy</h3>
      <p>Job data is stored securely with Supabase RLS. Marketing email signups are stored privately and never sold.</p>
    </article>
  </div>
</section>

<?php $capture_source = 'resources'; include __DIR__ . '/includes/email-capture.php'; ?>
<?php include __DIR__ . '/includes/footer.php'; ?>