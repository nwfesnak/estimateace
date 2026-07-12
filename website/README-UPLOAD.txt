HOSTINGER UPLOAD INSTRUCTIONS
=============================

1. Log into hPanel → Websites → File Manager → public_html
2. Upload ALL files from this /website folder into public_html:
   - index.php
   - solutions.php
   - pricing.php
   - resources.php
   - subscribe.php
   - .htaccess
   - /css/style.css
   - /includes/*.php
   - /data/ (empty folder for email leads)

3. Set permissions: /data folder writable (755 or 775) so subscribe.php can save leads.csv

4. Edit subscribe.php line 5: change support@estimateace.com to your real inbox

5. Visit https://estimateace.com — marketing site
   Visit https://app.estimateace.com — EstimateAce app

6. All "Log In" and "Get Started" buttons point to app.estimateace.com automatically.