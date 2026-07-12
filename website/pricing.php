<?php
$page_title = 'Pricing | EstimateAce — $39.99/mo or $430/yr';
$page_description = 'Simple contractor software pricing. Full platform access for $39.99/month or $430/year.';
include __DIR__ . '/includes/header.php';
$app_url = 'https://app.estimateace.com';
$monthly = 39.99;
$annual = 430;
$savings = round($monthly * 12 - $annual, 2);
?>

<section class="page-hero">
  <div class="container">
    <span class="eyebrow">Pricing</span>
    <h1>One plan. Every feature.</h1>
    <p class="lead">No per-estimate fees. No paid add-ons for AI or scheduling. Pick monthly flexibility or annual savings.</p>
  </div>
</section>

<section>
  <div class="container">
    <div class="pricing-grid">
      <article class="price-card">
        <h3>Monthly</h3>
        <div class="price">$<?= number_format($monthly, 2) ?> <small>/ month</small></div>
        <p class="price-note">Billed monthly · Cancel anytime</p>
        <ul class="feature-list" style="margin-bottom:1.5rem;">
          <li>Unlimited estimates & invoices</li>
          <li>AI Price Quote & descriptions</li>
          <li>Calendar & client notifications</li>
          <li>Photo, video & receipt capture</li>
          <li>Payment provider linking</li>
          <li>PWA — install on home screen</li>
          <li>English, Spanish & French</li>
        </ul>
        <a class="btn btn-outline btn-lg" href="<?= $app_url ?>" style="width:100%;">Start Monthly</a>
      </article>
      <article class="price-card featured">
        <span class="badge">Save 10%</span>
        <h3>Annual</h3>
        <div class="price">$<?= number_format($annual, 0) ?> <small>/ year</small></div>
        <p class="price-note">Save $<?= number_format($savings, 2) ?> vs monthly billing</p>
        <ul class="feature-list" style="margin-bottom:1.5rem;">
          <li>Everything in Monthly</li>
          <li>Locked annual rate</li>
          <li>Best for established crews</li>
          <li>Priority onboarding resources</li>
          <li>Same unlimited AI usage</li>
          <li>Appointment reminders included</li>
          <li>Export & archive included</li>
        </ul>
        <a class="btn btn-primary btn-lg" href="<?= $app_url ?>" style="width:100%;">Start Annual</a>
      </article>
    </div>
  </div>
</section>

<section class="soft">
  <div class="container cards-2">
    <article class="card"><h3>Is there a free trial?</h3><p>Log in at app.estimateace.com to explore. Contact support for extended trial options.</p></article>
    <article class="card"><h3>Are SMS/email included?</h3><p>The software is included. Twilio and Resend usage fees are billed by those providers separately.</p></article>
    <article class="card"><h3>Per-user pricing?</h3><p>Main account included. Additional crew accounts may be billed as you add team members in-app.</p></article>
    <article class="card"><h3>Payment processing fees?</h3><p>Third-party processors charge their own rates. EstimateAce does not take a cut of your transactions.</p></article>
  </div>
</section>

<?php $capture_source = 'pricing'; include __DIR__ . '/includes/email-capture.php'; ?>
<?php include __DIR__ . '/includes/footer.php'; ?>