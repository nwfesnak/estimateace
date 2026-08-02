<?php
$current_page = basename($_SERVER['PHP_SELF'], '.php');
$app_url = 'https://app.estimateace.com';
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="<?= htmlspecialchars($page_description ?? 'EstimateAce is field service software for contractors—estimates, AI pricing, scheduling, invoicing, and client notifications in one platform.') ?>" />
  <title><?= htmlspecialchars($page_title ?? 'EstimateAce | Field Service Management for Contractors') ?></title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
</head>
<body>
<div class="announce">Now live — Run your business at <a href="<?= $app_url ?>">app.estimateace.com</a></div>
<header class="site-header">
  <div class="container nav-wrap" id="top-nav">
    <a href="/index.php" class="logo">
      <span class="logo-mark">EA</span>
      <span>EstimateAce</span>
    </a>
    <button class="menu-toggle" type="button" aria-label="Menu" onclick="document.getElementById('top-nav').classList.toggle('nav-open')">☰</button>
    <nav class="nav-links">
      <a href="/index.php" class="<?= $current_page === 'index' ? 'active' : '' ?>">Home</a>
      <a href="/solutions.php" class="<?= $current_page === 'solutions' ? 'active' : '' ?>">Solutions</a>
      <a href="/pricing.php" class="<?= $current_page === 'pricing' ? 'active' : '' ?>">Pricing</a>
      <a href="/resources.php" class="<?= $current_page === 'resources' ? 'active' : '' ?>">Resources</a>
    </nav>
    <div class="nav-cta">
      <a class="btn btn-outline" href="<?= $app_url ?>">Log In</a>
      <a class="btn btn-primary" href="<?= $app_url ?>">Start Free Trial</a>
    </div>
  </div>
</header>
<main>