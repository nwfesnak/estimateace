document.querySelectorAll('.pillar-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.pillar-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.pillar-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById(target);
    if (panel) panel.classList.add('active');
  });
});