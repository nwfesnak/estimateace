<?php
$page_title = 'Solutions | EstimateAce for Home & Commercial Service Pros';
$page_description = 'Estimating, AI pricing, scheduling, invoicing, and field documentation solutions for HVAC, plumbing, electrical, remodeling, and more.';
include __DIR__ . '/includes/header.php';
$app_url = 'https://app.estimateace.com';
?>

<section class="page-hero">
  <div class="container">
    <span class="eyebrow">Solutions</span>
    <h1>Software that matches how you actually work</h1>
    <p class="lead">Every feature in EstimateAce maps to a real job-site problem—quoting, scheduling, documenting, and getting paid without drowning in admin.</p>
  </div>
</section>

<section>
  <div class="container cards-2">
    <article class="card icon-card" id="estimating">
      <div class="icon">EST</div>
      <h3>Estimating & proposals</h3>
      <p>Branded line-item estimates, terms, discounts, deposits, send preview, PDF export, and templates. Win jobs with clarity—not confusion.</p>
    </article>
    <article class="card icon-card" id="ai-pricing">
      <div class="icon">AI</div>
      <h3>AI Price Quote</h3>
      <p>Grok-powered materials and labor research with toggles for what clients see. Price confidently on complex jobs.</p>
    </article>
    <article class="card icon-card" id="invoicing">
      <div class="icon">PAY</div>
      <h3>Invoicing & closeout</h3>
      <p>Convert estimates, track outstanding, mark paid, archive jobs, and export CSV for bookkeeping.</p>
    </article>
    <article class="card icon-card" id="scheduling">
      <div class="icon">CAL</div>
      <h3>Scheduling & reminders</h3>
      <p>Calendar, appointment editing, client email/SMS, and daily contractor reminders at 8 AM Eastern.</p>
    </article>
    <article class="card icon-card" id="payments">
      <div class="icon">$$$</div>
      <h3>Payments</h3>
      <p>Link Stripe, PayPal, Venmo, Zelle, crypto processors, and more. You keep the processor relationship.</p>
    </article>
    <article class="card icon-card" id="field">
      <div class="icon">JOB</div>
      <h3>Field documentation</h3>
      <p>Photos, video, receipts, crew logins, Quick Lines, and secure cloud storage per job.</p>
    </article>
  </div>
</section>

<section class="soft">
  <div class="container">
    <div class="section-head">
      <h2>Industries we serve</h2>
    </div>
    <div class="cards-3">
      <article class="card" id="hvac">
        <img src="https://images.unsplash.com/photo-1581578731544-c64695cc6952?auto=format&fit=crop&w=800&q=80" alt="HVAC technician" />
        <h3>HVAC & mechanical</h3>
        <p>Equipment replacements, maintenance agreements, emergency calls, and seasonal scheduling with client notifications.</p>
      </article>
      <article class="card" id="plumbing">
        <img src="https://images.unsplash.com/photo-1607472586893-d537e3af0aff?auto=format&fit=crop&w=800&q=80" alt="Plumber" />
        <h3>Plumbing</h3>
        <p>Water heaters, re-pipes, and service calls with photo documentation and deposit collection on big tickets.</p>
      </article>
      <article class="card" id="electrical">
        <img src="https://images.unsplash.com/photo-1621905251918-48416bd8575a?auto=format&fit=crop&w=800&q=80" alt="Electrician" />
        <h3>Electrical</h3>
        <p>Panel upgrades, EV chargers, and commercial service with professional scope language powered by AI.</p>
      </article>
      <article class="card" id="remodeling">
        <img src="https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=800&q=80" alt="Remodeling" />
        <h3>Remodeling & GC</h3>
        <p>Multi-phase jobs with deposits, change-order-ready estimates, and archived paid projects.</p>
      </article>
      <article class="card" id="landscaping">
        <img src="https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=800&q=80" alt="Landscaping" />
        <h3>Landscaping & lawn</h3>
        <p>Recurring routes, Quick Lines for common services, and multilingual client support.</p>
      </article>
      <article class="card">
        <img src="https://images.unsplash.com/photo-1632778149395-6c13a7a9f296?auto=format&fit=crop&w=800&q=80" alt="Roofing" />
        <h3>Roofing & exteriors</h3>
        <p>Storm response quoting, photo proof, veteran discounts, and appointment scheduling built in.</p>
      </article>
    </div>
  </div>
</section>

<section>
  <div class="container final-cta" style="padding:2rem 0;">
    <h2>See it on your next estimate</h2>
    <p>Open the app and build a real quote in minutes.</p>
    <a class="btn btn-primary btn-lg" href="<?= $app_url ?>">Start Free Trial</a>
  </div>
</section>

<?php $capture_source = 'solutions'; include __DIR__ . '/includes/email-capture.php'; ?>
<?php include __DIR__ . '/includes/footer.php'; ?>