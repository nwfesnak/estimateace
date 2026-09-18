<?php
$page_title = 'AI Receptionist | EstimateAce Call Assistant for Contractors';
$page_description = 'Forward your existing business number to an EstimateAce AI line. It answers, collects name, phone, and address, and logs leads in your dashboard.';
include __DIR__ . '/includes/header.php';
$app_url = 'https://app.estimateace.com';
?>

<section class="page-hero">
  <div class="container">
    <span class="eyebrow">AI Receptionist · Paid add-on</span>
    <h1>Keep one business number. Let AI answer when you can’t.</h1>
    <p class="lead">
      Customers keep calling your existing line. You forward it to a private Twilio AI number.
      When AI answering is <strong>On</strong>, the receptionist greets callers, collects
      <strong>name, phone, and address</strong>, and logs leads in EstimateAce. When it’s
      <strong>Off</strong>, calls ring your host/cell silently — no “AI is off” announcement.
    </p>
    <div class="hero-actions" style="margin-top:1.25rem;">
      <a class="btn btn-primary btn-lg" href="<?= $app_url ?>">Open EstimateAce</a>
      <a class="btn btn-outline btn-lg" href="/pricing.php">See plans</a>
    </div>
  </div>
</section>

<section>
  <div class="container">
    <div class="section-head">
      <h2>What you get</h2>
      <p>Built for job-site pros who can’t sit by the phone all day.</p>
    </div>
    <div class="cards-2">
      <article class="card icon-card">
        <div class="icon">FWD</div>
        <h3>Call forwarding, not a second public number</h3>
        <p>Advertise your business number only. Forward it to your AI line. Turn AI answering On/Off in the app.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">LEAD</div>
        <h3>Captures name, phone &amp; address</h3>
        <p>The AI asks for contact details before wrapping up, then posts a lead to your Inbox and dashboard.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">KB</div>
        <h3>Answers from your knowledge base</h3>
        <p>Services, hours, service area, and FAQs you enter in EstimateAce drive the conversation.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">$</div>
        <h3>$49.99/month add-on</h3>
        <p>Subscribe under Billing → AI Receptionist, then enable your line once and forward your carrier number.</p>
      </article>
    </div>
    <p style="margin-top:1.5rem;font-size:0.95rem;color:#475569;">
      Speech recognition and AI answers can miss details — always review leads. Configure a host/cell
      number for when AI is Off or a caller asks for a person.
    </p>
  </div>
</section>

<?php include __DIR__ . '/includes/footer.php'; ?>
