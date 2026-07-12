<?php
// Email capture for Hostinger
// Primary: sends you an email notification
// Secondary: appends to data/leads.csv if the folder is writable

$notify_email = 'support@estimateace.com'; // ← CHANGE to your real inbox
$redirect_base = '/index.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  header('Location: ' . $redirect_base);
  exit;
}

$name = trim($_POST['name'] ?? '');
$email = trim($_POST['email'] ?? '');
$source = trim($_POST['source'] ?? 'website');
$referer = $_SERVER['HTTP_REFERER'] ?? $redirect_base;
$return_path = parse_url($referer, PHP_URL_PATH) ?: $redirect_base;

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
  header('Location: ' . $return_path . '?error=' . urlencode('Please enter a valid email address.'));
  exit;
}

$timestamp = date('c');
$saved_to_file = false;

// Try saving to CSV (optional — skip silently if Hostinger blocks writes)
$data_dir = __DIR__ . '/data';
$file = $data_dir . '/leads.csv';

if (!is_dir($data_dir)) {
  @mkdir($data_dir, 0755, true);
}

if (is_dir($data_dir) && is_writable($data_dir)) {
  $line = sprintf(
    "%s,%s,%s,%s\n",
    $timestamp,
    str_replace(',', ' ', $name),
    str_replace(',', ' ', $email),
    str_replace(',', ' ', $source)
  );
  $saved_to_file = @file_put_contents($file, $line, FILE_APPEND | LOCK_EX) !== false;
}

// Email notification (main capture method on shared hosting)
$emailed = false;
if ($notify_email) {
  $subject = 'New EstimateAce website signup';
  $body = "New email capture signup:\n\nName: $name\nEmail: $email\nSource: $source\nTime: $timestamp\nSaved to CSV: " . ($saved_to_file ? 'yes' : 'no');
  $headers = "From: noreply@estimateace.com\r\nReply-To: $email\r\nContent-Type: text/plain; charset=UTF-8";
  $emailed = @mail($notify_email, $subject, $body, $headers);
}

// Success if either method worked (email is enough)
if ($saved_to_file || $emailed) {
  header('Location: ' . $return_path . '?subscribed=1');
  exit;
}

header('Location: ' . $return_path . '?error=' . urlencode('Could not save signup. Email support@estimateace.com and we will add you manually.'));
exit;