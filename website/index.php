<?php
$page_title = 'EstimateAce | Field Service Management Software for Contractors';
$page_description = 'Quote, schedule, invoice, and get paid from one platform. AI pricing, client notifications, and mobile-first tools built for home service pros.';
include __DIR__ . '/includes/header.php';
$app_url = 'https://app.estimateace.com';
?>

<section class="hero">
  <div class="container hero-grid">
    <div>
      <h1>Run a stronger contracting business</h1>
      <p class="lead">From first quote to final payment, EstimateAce keeps your estimates, schedule, team, and revenue moving forward—on the job site and after hours.</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="<?= $app_url ?>">Start Free Trial</a>
        <a class="btn btn-outline btn-lg" href="/pricing.php">Find Your Plan</a>
      </div>
      <p class="hero-note">No credit card required · Works on phone, tablet, and desktop</p>
      <div class="trust-row">
        <div class="trust-item"><strong>4.9</strong><span>Contractor-rated workflow</span></div>
        <div class="trust-item"><strong>2 min</strong><span>Average estimate build</span></div>
        <div class="trust-item"><strong>50+</strong><span>Trades supported</span></div>
      </div>
    </div>
    <div class="mockup-wrap">
      <div class="app-mockup">
        <div class="mock-top">
          <div class="mock-dots"><i></i><i></i><i></i></div>
          <span>EstimateAce · Dashboard</span>
          <span>app.estimateace.com</span>
        </div>
        <div class="mock-body">
          <ul class="mock-sidebar">
            <li class="on">Dashboard</li>
            <li>Estimates</li>
            <li>Invoices</li>
            <li>Calendar</li>
            <li>Reports</li>
            <li>Profile</li>
          </ul>
          <div class="mock-main">
            <div class="mock-stat-row">
              <div class="mock-stat"><span>Outstanding</span><strong>$12,480</strong></div>
              <div class="mock-stat"><span>Active estimates</span><strong>18</strong></div>
              <div class="mock-stat"><span>Tomorrow</span><strong>4 jobs</strong></div>
            </div>
            <div class="mock-table">
              <div class="row head"><span>Job</span><span>Status</span><span>Total</span></div>
              <div class="row"><span>Kitchen remodel — EST-1042</span><span>Sent</span><span>$8,240</span></div>
              <div class="row"><span>Panel upgrade — EST-1038</span><span>Approved</span><span>$3,150</span></div>
              <div class="row"><span>AC tune-up — EST-1035</span><span>Scheduled</span><span>$189</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="mock-badge"><strong>AI quote ready</strong>Materials & labor priced in seconds</div>
    </div>
  </div>
</section>

<div class="logo-strip">
  <div class="container">
    <span>HVAC</span><span>PLUMBING</span><span>ELECTRICAL</span><span>REMODELING</span><span>LANDSCAPING</span><span>ROOFING</span><span>HANDYMAN</span>
  </div>
</div>

<section class="pillars">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">Platform</span>
      <h2>The all-in-one system for high-performing service pros</h2>
      <p>Quote faster, schedule smarter, look professional, and get paid—without switching between five different tools.</p>
    </div>
    <div class="pillar-tabs">
      <button class="pillar-tab active" data-tab="panel-quote" type="button">Win Jobs</button>
      <button class="pillar-tab" data-tab="panel-schedule" type="button">Schedule</button>
      <button class="pillar-tab" data-tab="panel-paid" type="button">Get Paid</button>
      <button class="pillar-tab" data-tab="panel-ai" type="button">AI Pricing</button>
    </div>

    <div class="pillar-panel active" id="panel-quote">
      <div class="pillar-grid">
        <div class="pillar-copy">
          <h3>Send estimates that win the job</h3>
          <p>Build branded proposals with line items, terms, photos, and deposits. Send a client-ready preview and PDF while you're still in the driveway.</p>
          <ul class="feature-list">
            <li>Professional estimate & invoice PDFs</li>
            <li>Discounts, deposits, and approval flows</li>
            <li>Job photos and video attached to documents</li>
            <li>English, Spanish, and French built in</li>
          </ul>
          <div class="stat-callout"><strong>Contractors report faster approvals</strong> when clients receive clear, branded quotes the same day.</div>
          <a class="btn btn-dark" href="/solutions.php#estimating">Explore estimating →</a>
        </div>
        <div class="pillar-img">
          <img src="https://images.unsplash.com/photo-1600880292203-757bb62b4baf?auto=format&fit=crop&w=1100&q=80" alt="Contractor meeting with homeowner" />
        </div>
      </div>
    </div>

    <div class="pillar-panel" id="panel-schedule">
      <div class="pillar-grid">
        <div class="pillar-copy">
          <h3>Schedule work and notify clients automatically</h3>
          <p>Book appointments from any estimate, view your month at a glance, edit bookings on the fly, and send email and SMS confirmations—no more "what time was it?" texts.</p>
          <ul class="feature-list">
            <li>Calendar with month view and appointment editing</li>
            <li>Client email notifications on booking & updates</li>
            <li>SMS alerts via your Twilio number</li>
            <li>Daily 8 AM reminder for tomorrow's jobs</li>
          </ul>
          <div class="stat-callout"><strong>Fewer no-shows</strong> when customers get professional confirmations instantly.</div>
          <a class="btn btn-dark" href="/solutions.php#scheduling">Explore scheduling →</a>
        </div>
        <div class="pillar-img">
          <img src="https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1100&q=80" alt="Team planning schedule" />
        </div>
      </div>
    </div>

    <div class="pillar-panel" id="panel-paid">
      <div class="pillar-grid">
        <div class="pillar-copy">
          <h3>Invoice, collect, and close out jobs</h3>
          <p>Convert approved estimates to invoices in one tap. Track outstanding balances, link payment methods you already use, and archive paid work for clean books.</p>
          <ul class="feature-list">
            <li>Stripe, PayPal, Venmo, Zelle, Cash App, crypto links</li>
            <li>Dashboard outstanding invoice totals</li>
            <li>Mark paid and archive completed jobs</li>
            <li>CSV export for your accountant</li>
          </ul>
          <div class="stat-callout"><strong>Get paid faster</strong> when clients can pay the way they prefer.</div>
          <a class="btn btn-dark" href="/solutions.php#invoicing">Explore invoicing →</a>
        </div>
        <div class="pillar-img">
          <img src="https://images.unsplash.com/photo-1556740758-90de374c12ad?auto=format&fit=crop&w=1100&q=80" alt="Mobile payment" />
        </div>
      </div>
    </div>

    <div class="pillar-panel" id="panel-ai">
      <div class="pillar-grid">
        <div class="pillar-copy">
          <h3>AI built for contractors in the field</h3>
          <p>Describe the job and EstimateAce researches materials, labor, and market pricing. You control what the client sees—full breakdown or clean professional scope.</p>
          <ul class="feature-list">
            <li>Detailed materials list with qty, unit, and pricing</li>
            <li>Labor hours and rate breakdown</li>
            <li>Toggle client visibility for materials & labor</li>
            <li>Smart address autocomplete while typing job sites</li>
          </ul>
          <div class="stat-callout"><strong>Price with confidence</strong> instead of guessing after a long day in the field.</div>
          <a class="btn btn-dark" href="<?= $app_url ?>">Try AI pricing →</a>
        </div>
        <div class="pillar-img">
          <img src="https://images.unsplash.com/photo-1486406146926-c627a92fd1ab?auto=format&fit=crop&w=1100&q=80" alt="Modern business technology" />
        </div>
      </div>
    </div>
  </div>
</section>

<section class="dark">
  <div class="container">
    <div class="section-head">
      <h2>Built for contractors who run on hustle and precision</h2>
      <p style="color:#94a3b8;">Real workflows. Real numbers. No fluff.</p>
    </div>
    <div class="stats-band">
      <div><strong>10+</strong><span>Hours saved weekly on admin*</span></div>
      <div><strong>1</strong><span>Platform from quote to payment</span></div>
      <div><strong>3</strong><span>Languages supported</span></div>
      <div><strong>24/7</strong><span>Access from any device</span></div>
    </div>
    <p style="text-align:center;margin-top:1.5rem;font-size:0.8rem;color:#64748b;">*Based on typical contractor workflows vs. paper + spreadsheets</p>
  </div>
</section>

<section>
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">Industries</span>
      <h2>Proud partner to service pros across the trades</h2>
    </div>
    <div class="industry-chips">
      <a href="/solutions.php#hvac">HVAC</a>
      <a href="/solutions.php#plumbing">Plumbing</a>
      <a href="/solutions.php#electrical">Electrical</a>
      <a href="/solutions.php#remodeling">Remodeling</a>
      <a href="/solutions.php#landscaping">Landscaping</a>
      <a href="/solutions.php">Roofing</a>
      <a href="/solutions.php">Handyman</a>
      <a href="/solutions.php">Cleaning</a>
      <a href="/solutions.php">Painting</a>
      <a href="/solutions.php">Pool & Spa</a>
    </div>
  </div>
</section>

<section class="soft">
  <div class="container">
    <div class="section-head">
      <h2>Contractors on EstimateAce</h2>
    </div>
    <div class="testimonial-grid">
      <article class="quote-card">
        <p>"I send the estimate before I leave the driveway. Customers take me more seriously than the guy who says he'll email it tomorrow."</p>
        <div class="quote-author">
          <img class="avatar" src="https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=100&q=80" alt="" />
          <div><strong>Marcus Reid</strong><span>Reid Electric · Charlotte, NC</span></div>
        </div>
      </article>
      <article class="quote-card">
        <p>"The AI pricing gives me a starting point on materials I would've forgotten—fasteners, consumables, all of it. I still control the final number."</p>
        <div class="quote-author">
          <img class="avatar" src="https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=100&q=80" alt="" />
          <div><strong>Angela Torres</strong><span>Torres Remodeling · Austin, TX</span></div>
        </div>
      </article>
      <article class="quote-card">
        <p>"Calendar plus text reminders cut our no-shows way down. And I get a morning text with tomorrow's jobs—game changer."</p>
        <div class="quote-author">
          <img class="avatar" src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=100&q=80" alt="" />
          <div><strong>James Cole</strong><span>Cole HVAC Services · Denver, CO</span></div>
        </div>
      </article>
    </div>
  </div>
</section>

<section>
  <div class="container">
    <div class="section-head">
      <h2>Simple, transparent pricing</h2>
      <p>One plan with everything included. No per-estimate fees.</p>
    </div>
    <div class="pricing-grid" style="max-width:760px;">
      <article class="price-card">
        <h3>Monthly</h3>
        <div class="price">$39.99 <small>/mo</small></div>
        <p class="price-note">Full platform access. Cancel anytime.</p>
        <a class="btn btn-outline btn-lg" href="<?= $app_url ?>" style="width:100%;">Start trial</a>
      </article>
      <article class="price-card featured">
        <span class="badge">Save 10%</span>
        <h3>Annual</h3>
        <div class="price">$430 <small>/yr</small></div>
        <p class="price-note">Best value for established shops.</p>
        <a class="btn btn-primary btn-lg" href="/pricing.php" style="width:100%;">See full pricing</a>
      </article>
    </div>
  </div>
</section>

<?php $capture_source = 'homepage'; include __DIR__ . '/includes/email-capture.php'; ?>

<section class="final-cta">
  <div class="container">
    <h2>You've got this. We've got your back.</h2>
    <p>Join contractors who quote faster, look sharper, and get paid without the paperwork headache.</p>
    <a class="btn btn-primary btn-lg" href="<?= $app_url ?>">Start Free Trial</a>
    <p class="hero-note" style="margin-top:0.75rem;">No credit card required</p>
  </div>
</section>

<?php include __DIR__ . '/includes/footer.php'; ?>