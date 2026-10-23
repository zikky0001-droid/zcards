# ==========================================
# ZCard Control Room - Environment Variables
# ==========================================
# Copy these values into your Environment Variables.
# NEVER commit this file with real passwords/keys to GitHub.


# 1. Authentication & API Keys
# The secret key to access the private Admin Dashboard (/api/admin/)
ADMIN_KEY=your_super_secret_admin_key_here

# Comma-separated list of API keys for protected public endpoints.
# These keys protect /api/cards, /api/events, /api/stats, /api/series, /api/random.
# Format: API_KEYS=key1,key2,key3
API_KEYS=your_first_api_key,your_second_api_key,your_third_api_key

# 2. Supabase Configuration
# Your Supabase Project URL (found in Project Settings > API)
  SUPABASE_URL = https://your-project-id.supabase.co

# Your Supabase Service Role Key (found in Project Settings > API > service_role)

# WARNING: Keep this secret. It bypasses Row Level Security.

# 4. SUPABASE_SERVICE_ROLE_KEY = your_supabase_service_role_key_here

# 5 The name of your private storage bucket
 SUPABASE_STORAGE_BUCKET = shoob-catalogs


