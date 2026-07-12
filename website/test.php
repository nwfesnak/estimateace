<?php
// Upload to public_html and visit https://estimateace.com/test.php
// Delete this file after your site works.
header('Content-Type: text/plain; charset=UTF-8');
echo "PHP is working on EstimateAce hosting.\n";
echo "Server time: " . date('c') . "\n";
echo "Document root: " . ($_SERVER['DOCUMENT_ROOT'] ?? 'unknown') . "\n";
echo "This folder: " . __DIR__ . "\n";
echo "index.php exists: " . (file_exists(__DIR__ . '/index.php') ? 'yes' : 'NO - upload index.php') . "\n";