Claimclub.io - deploy to Vercel
================================
1. Open a terminal in this folder (in File Explorer: click the address bar, type cmd, press Enter).
2. Run:   npx vercel deploy --prod
   - First time it asks you to log in and to name the project. Accept the defaults.
3. Add your Stripe TEST secret key (Stripe dashboard > Developers > API keys, starts with sk_test_):
     npx vercel env add STRIPE_SECRET_KEY production
   then redeploy:   npx vercel deploy --prod
4. Test with card 4242 4242 4242 4242, any future date, any CVC.

Optional (payment confirmations in the background):
  Stripe dashboard > Developers > Webhooks > Add endpoint
    URL:    https://<your-site>.vercel.app/api/webhook
    Events: checkout.session.completed, customer.subscription.deleted
  Copy the signing secret (whsec_...) and run:
     npx vercel env add STRIPE_WEBHOOK_SECRET production
  then redeploy.

Optional (fixed Stripe products instead of inline prices):
  STRIPE_PRICE_FEE, STRIPE_PRICE_1M, STRIPE_PRICE_3M, STRIPE_PRICE_6M = price IDs (price_...)
