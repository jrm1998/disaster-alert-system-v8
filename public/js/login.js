// Login / registration page
document.addEventListener('DOMContentLoaded', async () => {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const params = new URLSearchParams(location.search);
  const redirect = params.get('redirect');

  // If already logged in, go straight to dashboard
  try {
    const me = await api.get('/api/auth/me');
    if (me && me.id) location.href = '/dashboard.html';
  } catch { /* not logged in */ }

  if (params.get('mode') === 'register') toggleRegister();

  // Populate barangay dropdown
  try {
    const barangays = await api.get('/api/auth/barangays');
    const sel = document.getElementById('reg-barangay');
    barangays.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.name;
      sel.appendChild(opt);
    });
  } catch { /* dropdown stays empty */ }

  document.getElementById('show-register').addEventListener('click', e => { e.preventDefault(); toggleRegister(); });
  document.getElementById('show-login').addEventListener('click', e => { e.preventDefault(); toggleLogin(); });

  function toggleRegister() {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    document.getElementById('form-title').textContent = 'Create Account';
  }
  function toggleLogin() {
    registerForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    document.getElementById('form-title').textContent = 'Login';
  }

  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/auth/login', {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
      });
      location.href = redirect === 'report' ? '/#report' : '/dashboard.html';
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  registerForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/auth/register', {
        name: document.getElementById('reg-name').value,
        email: document.getElementById('reg-email').value,
        password: document.getElementById('reg-password').value,
        phone: document.getElementById('reg-phone').value,
        role: document.getElementById('reg-role').value,
        barangay_id: document.getElementById('reg-barangay').value || null
      });
      toast('Account created. Welcome!', 'success');
      setTimeout(() => { location.href = '/dashboard.html'; }, 600);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});
