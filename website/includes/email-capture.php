<?php
$source = $capture_source ?? 'website';
$success = isset($_GET['subscribed']) && $_GET['subscribed'] === '1';
$error = $_GET['error'] ?? '';
?>
<section class="soft">
  <div class="container">
    <div class="cta-band">
      <div>
        <h3>Get the contractor playbook + product updates</h3>
        <p>Practical tips on estimating, scheduling, and getting paid—plus new EstimateAce features. Unsubscribe anytime.</p>
      </div>
      <div>
        <?php if ($success): ?><div class="alert alert-success">You're subscribed. Check your inbox soon.</div><?php endif; ?>
        <?php if ($error): ?><div class="alert alert-error"><?= htmlspecialchars($error) ?></div><?php endif; ?>
        <form class="capture-form" method="post" action="/subscribe.php">
          <input type="hidden" name="source" value="<?= htmlspecialchars($source) ?>" />
          <input type="text" name="name" placeholder="Full name" aria-label="Full name" />
          <input type="email" name="email" placeholder="Work email" required aria-label="Email" />
          <button class="btn btn-primary" type="submit">Subscribe</button>
        </form>
      </div>
    </div>
  </div>
</section>