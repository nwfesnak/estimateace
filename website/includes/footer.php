<?php $app_url = 'https://app.estimateace.com'; ?>
</main>
<footer class="site-footer">
  <div class="container footer-grid">
    <div>
      <div class="logo" style="color:#fff;margin-bottom:0.85rem;">
        <span class="logo-mark">EA</span>
        <span>EstimateAce</span>
      </div>
      <p style="margin:0;max-width:34ch;line-height:1.6;">The all-in-one platform for contractors who quote in the field, schedule the work, and get paid—without the paperwork pile.</p>
    </div>
    <div>
      <h4>Product</h4>
      <ul>
        <li><a href="/solutions.php">Solutions</a></li>
        <li><a href="/pricing.php">Pricing</a></li>
        <li><a href="/resources.php">Resources</a></li>
        <li><a href="<?= $app_url ?>">Open App</a></li>
      </ul>
    </div>
    <div>
      <h4>Industries</h4>
      <ul>
        <li><a href="/solutions.php#hvac">HVAC</a></li>
        <li><a href="/solutions.php#plumbing">Plumbing</a></li>
        <li><a href="/solutions.php#electrical">Electrical</a></li>
        <li><a href="/solutions.php#landscaping">Landscaping</a></li>
      </ul>
    </div>
    <div>
      <h4>Support</h4>
      <ul>
        <li><a href="mailto:support@estimateace.com">support@estimateace.com</a></li>
        <li><a href="/resources.php#privacy">Privacy</a></li>
        <li><a href="/resources.php#terms">Terms</a></li>
      </ul>
    </div>
  </div>
  <div class="container footer-bottom">
    <span>© <?= date('Y') ?> EstimateAce. All rights reserved.</span>
    <span>Application: <a href="<?= $app_url ?>">app.estimateace.com</a></span>
  </div>
</footer>
<script src="/js/main.js" defer></script>
</body>
</html>