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
      <div class="footer-social">
        <a href="https://www.facebook.com/profile.php?id=61595123422243" target="_blank" rel="noopener noreferrer" aria-label="EstimateAce on Facebook">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M16 8.049c0-4.446-3.582-8.05-8-8.05C3.58 0-.002 3.603-.002 8.05c0 4.017 2.926 7.347 6.75 7.951v-5.625h-2.03V8.05H6.75V6.275c0-2.017 1.195-3.131 3.022-3.131.876 0 1.791.157 1.791.157v1.98h-1.009c-.993 0-1.303.621-1.303 1.258v1.51h2.218l-.354 2.326H9.25V16c3.824-.604 6.75-3.934 6.75-7.951"/>
          </svg>
        </a>
      </div>
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
        <li><a href="mailto:admin@estimateace.com">admin@estimateace.com</a></li>
        <li><a href="<?= $app_url ?>/privacy">Privacy</a></li>
        <li><a href="<?= $app_url ?>/terms">Terms</a></li>
        <li><a href="<?= $app_url ?>/terms#cancellation">Cancellation &amp; refunds</a></li>
      </ul>
    </div>
  </div>
  <div class="container footer-bottom">
    <span>© <?= date('Y') ?> EstimateAce. All rights reserved.</span>
    <span>Application: <a href="<?= $app_url ?>">app.estimateace.com</a></span>
  </div>
</footer>
<script src="/js/main.js" defer></script>
<script src="/js/chat-widget.js?v=20260907c" defer></script>
</body>
</html>