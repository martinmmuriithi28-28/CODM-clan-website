# Put the Kenya One site online with GitHub and Vercel

You need: a GitHub account, a Vercel account, and the unzipped k1-site folder.

## 1. GitHub
1. Sign in at github.com. Tap New repository. Name it k1-site. Choose Private. Create it.
2. Tap "uploading an existing file". Upload everything INSIDE the unzipped k1-site folder:
   server.js, seed.json, package.json, vercel.json, and the folders `api` and `public` (keep the folders as they are).
3. Tap Commit changes.

## 2. Vercel
1. Sign in at vercel.com with your GitHub account.
2. Add New > Project > pick k1-site > Import.
3. Leave the settings as they are (Framework: Other). Tap Deploy.

## 3. Database (this is where the roster is kept)
1. In the Vercel project, open the Storage tab > Create Database > Upstash (Redis) > pick the free plan > Create.
2. Connect it to your k1-site project. Vercel then adds the database settings by itself.

## 4. Your owner code
1. Project > Settings > Environment Variables.
2. Add: Name OWNER_CODE, Value = an 8-digit number only you know. Save.

## 5. Deploy again
Deployments > the latest one > Redeploy. Wait until it says Ready, then open the link Vercel shows.

## 6. First login
Tap Log in, pick NØCTRAX, type your OWNER_CODE. Then Leader setup > Login codes to make codes for the other leaders.

## Good to know
- The first visit fills the roster with the 48 names. After that the site keeps everything in the database.
- Pictures that leaders upload must be under 700 KB.
- The page checks for changes every 3 seconds, so other people's changes show up within about 3 to 5 seconds. Your own changes show at once.
- To back up the data, open the database in the Upstash dashboard (Storage tab) and use its data browser.
- Changing OWNER_CODE later and redeploying resets the owner login code.
