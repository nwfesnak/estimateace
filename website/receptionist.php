<?php
$page_title = 'AI Receptionist | EstimateAce 24/7 Call Assistant for Contractors';
$page_description = 'Never miss a lead. EstimateAce AI Receptionist answers calls 24/7, takes messages, flags urgents, books appointments, and answers service questions — for contractors and small businesses.';
include __DIR__ . '/includes/header.php';
$app_url = 'https://app.estimateace.com';
?>

<section class="page-hero">
  <div class="container">
    <span class="eyebrow">AI Receptionist</span>
    <h1>Your 24/7 virtual front desk</h1>
    <p class="lead">A virtual phone and call assistant designed for small businesses and contractors. It answers when you can’t — so you never miss leads or important calls.</p>
    <div class="hero-actions" style="margin-top:1.25rem;">
      <a class="btn btn-primary btn-lg" href="<?= $app_url ?>">Open in EstimateAce</a>
      <a class="btn btn-outline btn-lg" href="/pricing.php">See plans</a>
    </div>
  </div>
</section>

<section>
  <div class="container">
    <div class="section-head">
      <h2>What it does</h2>
      <p>Built for job-site pros who can’t sit by the phone all day.</p>
    </div>
    <div class="cards-2">
      <article class="card icon-card">
        <div class="icon">24/7</div>
        <h3>Answers &amp; manages calls around the clock</h3>
        <p>Handles unanswered, missed, or after-hours calls. Set standard call forwarding from your existing number — no porting and no second number required.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">MSG</div>
        <h3>Takes messages &amp; summarizes conversations</h3>
        <p>Captures what the caller wants, creates clear summaries, generates action items, and can notify you with the details.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">CAL</div>
        <h3>Schedules appointments</h3>
        <p>Books meetings and callbacks into your EstimateAce calendar in a natural-sounding way — while you’re on a roof or in a crawlspace.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">!</div>
        <h3>Flags urgent messages</h3>
        <p>Priority calls (leaks, no heat, emergencies) are highlighted so you respond faster to what matters most.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">KB</div>
        <h3>Answers business questions</h3>
        <p>Using a knowledge base you fill out in the app (and text from your website), it responds accurately about services, pricing ranges, availability, and more.</p>
      </article>
      <article class="card icon-card">
        <div class="icon">🌐</div>
        <h3>Speaks multiple languages</h3>
        <p>Multilingual support so you can communicate with a wider range of callers — without hiring a bilingual front desk.</p>
      </article>
    </div>
  </div>
</section>

<section class="soft">
  <div class="container">
    <div class="section-head">
      <h2>Sounds human. Works like a pro.</h2>
      <p>Natural voice-style conversation that makes callers feel they’re talking to a real person — not a rigid phone tree.</p>
    </div>
    <ul class="feature-list" style="max-width:40rem;margin:0 auto;">
      <li>Call transcripts you can review anytime</li>
      <li>Spam detection / screening</li>
      <li>Customizable greetings (business hours &amp; after hours)</li>
      <li>Push-style notifications when you’re set up for SMS/email alerts</li>
      <li>Test call mode inside EstimateAce before you go live</li>
    </ul>
  </div>
</section>

<section>
  <div class="container final-cta" style="padding:2rem 0;">
    <h2>Turn on your AI front desk</h2>
    <p>Log in to EstimateAce → Dashboard → AI Receptionist. Build your knowledge base, set greetings, and run a test call in minutes.</p>
    <a class="btn btn-primary btn-lg" href="<?= $app_url ?>">Start Free Trial</a>
  </div>
</section>

<?php $capture_source = 'receptionist'; include __DIR__ . '/includes/email-capture.php'; ?>
<?php include __DIR__ . '/includes/footer.php'; ?>
