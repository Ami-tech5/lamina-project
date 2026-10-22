import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { db, User, Investment, normalizeCameroonPhone } from './server/db.js';
import {
  processDeposit,
  processWithdrawal,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
  adminApproveDeposit,
  adminRejectDeposit,
  runDailyDividendEngine,
  processAutomatic24hDividends,
  deleteUserAccount,
  getLiveTickerFeed,
  generateId,
} from './server/engine.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Background automatic 24H mineral yield payment engine:
// Evaluates active contracts and pays out 40% profit after 24H of started time every day
setInterval(() => {
  try {
    processAutomatic24hDividends();
  } catch (err) {
    console.error('Automatic 24H dividend processor error:', err);
  }
}, 15000); // Check every 15 seconds

// -----------------------------------------------------------------
// USER AUTHENTICATION & SIGNUP MATRIX
// -----------------------------------------------------------------

// POST /api/user/signup
app.post('/api/user/signup', (req: Request, res: Response) => {
  try {
    const { phone, password, name, referrerPhone } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required.' });
    }

    const cleanPhone = normalizeCameroonPhone(phone);
    if (!cleanPhone || cleanPhone.length < 8) {
      return res.status(400).json({ error: 'Please enter a valid Cameroon phone number (e.g. 677777777).' });
    }

    const cleanReferrer = referrerPhone ? normalizeCameroonPhone(referrerPhone) : undefined;
    const data = db.getData();

    const existing = data.users.find(u => normalizeCameroonPhone(u.phone) === cleanPhone);
    if (existing) {
      return res.status(400).json({ error: 'An account with this phone number already exists. Please sign in.' });
    }

    const userId = generateId('USR');
    const signupBonus = data.settings.signupBonus || 250;

    const newUser: User = {
      id: userId,
      phone: cleanPhone,
      name: name?.trim() || `Investor ${cleanPhone.slice(-4)}`,
      passwordHash: password.trim(),
      balance: signupBonus,
      totalDeposited: 0,
      totalWithdrawn: 0,
      referrerPhone: cleanReferrer,
      createdAt: new Date().toISOString(),
    };

    data.users.push(newUser);

    const newInvestment: Investment = {
      id: generateId('INV'),
      userId: newUser.id,
      productName: 'Starter Mineral Assay Node',
      mineralType: 'Multi-Mineral',
      amountInvested: 0,
      dailyRate: 0.40,
      dailyYield: 0,
      status: 'No Active Product',
      totalEarned: 0,
      location: 'Western Australia Field Office',
    };
    data.investments.push(newInvestment);

    data.history.unshift({
      id: generateId('BONUS'),
      userId: newUser.id,
      phone: newUser.phone,
      type: 'SIGNUP_BONUS',
      amount: signupBonus,
      carrier: 'SYSTEM',
      status: 'SUCCESSFUL',
      timestamp: new Date().toISOString(),
      description: `LAMINA Australia Welcome Bonus (${signupBonus.toFixed(2)} frs Credit)`,
    });

    db.save();

    return res.json({
      success: true,
      message: `Account created successfully with ${signupBonus.toFixed(2)} frs Welcome Credit!`,
      userId: newUser.id,
      user: {
        id: newUser.id,
        phone: newUser.phone,
        name: newUser.name,
        balance: newUser.balance,
        referrerPhone: newUser.referrerPhone,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /api/user/login
app.post('/api/user/login', (req: Request, res: Response) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone number and password are required.' });
    }
    const cleanPhone = normalizeCameroonPhone(phone);
    const data = db.getData();

    const user = data.users.find(u => normalizeCameroonPhone(u.phone) === cleanPhone);
    if (!user || user.passwordHash !== password.trim()) {
      return res.status(401).json({ error: 'Invalid phone number or password.' });
    }

    user.lastLoginAt = new Date().toISOString();
    user.lastActiveAt = new Date().toISOString();
    processAutomatic24hDividends();
    db.save();

    return res.json({
      success: true,
      message: 'Authentication successful.',
      userId: user.id,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        balance: user.balance,
        referrerPhone: user.referrerPhone,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        lastActiveAt: user.lastActiveAt,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /api/user/me
app.get('/api/user/me', (req: Request, res: Response) => {
  try {
    // Process any due 24h dividend cycles automatically
    processAutomatic24hDividends();

    const userId = req.headers['x-user-id'] as string || req.query.userId as string;
    const data = db.getData();

    let user: User | undefined;
    if (userId) {
      user = data.users.find(u => u.id === userId || normalizeCameroonPhone(u.phone) === normalizeCameroonPhone(userId));
    }
    if (!user) {
      return res.json({
        user: null,
        investments: [],
        activeInvestment: null,
        history: [],
        settings: {
          brandName: data.settings.brandName || 'LAMINA Cloud Mining',
          country: data.settings.country || 'Australia',
          maxHashrateFrs: data.settings.maxHashrateFrs || 500000,
          autoWebhook: data.settings.autoWebhook,
          minWithdrawal: data.settings.minWithdrawal,
          dailyYieldPercent: data.settings.dailyYieldPercent,
          depositNumbers: data.settings.depositNumbers || {
            mtn: ['683105070'],
            orange: ['640585447'],
          },
          momoAccountName: data.settings.momoAccountName || 'LAMINA LUCY LONGLA',
          orangeAccountName: data.settings.orangeAccountName || 'LAMINA ATANLEY AMBI',
          customerSupportNumber: '+237655958337',
        },
      });
    }

    user.lastActiveAt = new Date().toISOString();
    db.save();

    const investments = data.investments.filter(i => i.userId === user.id);
    const history = data.history.filter(h => h.userId === user.id);
    const activeInvestment = investments.find(i => i.status === 'ACTIVE') || investments[0] || null;

    return res.json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        balance: user.balance,
        totalDeposited: user.totalDeposited,
        totalWithdrawn: user.totalWithdrawn,
        referrerPhone: user.referrerPhone,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        lastActiveAt: user.lastActiveAt,
      },
      investments,
      activeInvestment,
      history: history.slice(0, 15),
      settings: {
        brandName: data.settings.brandName || 'LAMINA Cloud Mining',
        country: data.settings.country || 'Australia',
        maxHashrateFrs: data.settings.maxHashrateFrs || 500000,
        autoWebhook: data.settings.autoWebhook,
        minWithdrawal: data.settings.minWithdrawal,
        dailyYieldPercent: data.settings.dailyYieldPercent,
        depositNumbers: data.settings.depositNumbers || {
          mtn: ['683105070'],
          orange: ['640585447'],
        },
        momoAccountName: data.settings.momoAccountName || 'LAMINA LUCY LONGLA',
        orangeAccountName: data.settings.orangeAccountName || 'LAMINA ATANLEY AMBI',
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /api/deposit-numbers
app.get('/api/deposit-numbers', (_req: Request, res: Response) => {
  const data = db.getData();
  return res.json({
    depositNumbers: data.settings.depositNumbers || {
      mtn: ['683105070'],
      orange: ['640585447'],
    },
    momoAccountName: data.settings.momoAccountName || 'LAMINA LUCY LONGLA',
    orangeAccountName: data.settings.orangeAccountName || 'LAMINA ATANLEY AMBI',
  });
});

// GET /api/user/list
app.get('/api/user/list', (_req: Request, res: Response) => {
  const data = db.getData();
  const list = data.users.map(u => ({
    id: u.id,
    phone: u.phone,
    name: u.name,
    balance: u.balance,
    referrerPhone: u.referrerPhone,
  }));
  return res.json({ users: list });
});

// -----------------------------------------------------------------
// MOBILE MONEY PAYMENT GATEWAY (DEPOSITS & WITHDRAWALS)
// -----------------------------------------------------------------

// POST /api/momo/deposit
app.post('/api/momo/deposit', (req: Request, res: Response) => {
  try {
    const { phone, amount, carrier, senderName, recipientNumber, recipientName } = req.body;
    if (!phone || !amount || !carrier) {
      return res.status(400).json({ error: 'Phone, amount, and carrier are required.' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Valid deposit amount required.' });
    }

    const result = processDeposit(
      cleanPhone,
      numAmount,
      carrier,
      senderName,
      recipientNumber,
      recipientName
    );
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Deposit failed' });
  }
});

// POST /api/momo/withdraw
app.post('/api/momo/withdraw', (req: Request, res: Response) => {
  try {
    const { phone, amount, carrier, receiverFullName } = req.body;
    if (!phone || !amount || !carrier) {
      return res.status(400).json({ error: 'Phone, amount, and carrier are required.' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Valid withdrawal amount required.' });
    }

    const result = processWithdrawal(cleanPhone, numAmount, carrier, receiverFullName);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Withdrawal failed' });
  }
});

// -----------------------------------------------------------------
// AUSTRALIAN MINERAL CLOUD MINING CONTRACTS (GOLD, SILVER, PLATINUM)
// Max Hashrate / Investment Capacity: 500,000 frs
// -----------------------------------------------------------------

// POST /api/invest/activate
app.post('/api/invest/activate', (req: Request, res: Response) => {
  try {
    const { userId, productName, amount, mineralType, location } = req.body;
    const numAmount = parseFloat(amount);

    if (!userId || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Invalid investment parameters.' });
    }

    // Constraint: Max hashrate / capacity is 500,000 frs
    if (numAmount > 500000) {
      return res.status(400).json({ error: 'Maximum mineral hashrate limit is 500,000 frs per node cluster.' });
    }

    const data = db.getData();
    const user = data.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.balance < numAmount) {
      return res.status(400).json({ error: `Insufficient wallet balance (${user.balance.toLocaleString()} frs available). Please top up via MoMo/OM.` });
    }

    user.balance -= numAmount;

    let inv = data.investments.find(i => i.userId === user.id && i.status === 'ACTIVE');
    if (inv) {
      inv.amountInvested = Math.min(inv.amountInvested + numAmount, 500000);
      inv.dailyYield = Math.round(inv.amountInvested * 0.40);
      inv.productName = productName || inv.productName;
      inv.mineralType = mineralType || inv.mineralType || 'Gold';
    } else {
      let existingBlank = data.investments.find(i => i.userId === user.id && i.status === 'No Active Product');
      if (existingBlank) {
        existingBlank.amountInvested = numAmount;
        existingBlank.dailyYield = Math.round(numAmount * 0.40);
        existingBlank.status = 'ACTIVE';
        existingBlank.productName = productName || 'Australian Gold Stope Node';
        existingBlank.mineralType = mineralType || 'Gold';
        existingBlank.location = location || 'Western Australia Mining Field';
        existingBlank.startDate = new Date().toISOString();
      } else {
        data.investments.push({
          id: generateId('INV'),
          userId: user.id,
          productName: productName || 'Australian Mineral Cloud Node',
          mineralType: mineralType || 'Gold',
          amountInvested: numAmount,
          dailyRate: 0.40,
          dailyYield: Math.round(numAmount * 0.40),
          status: 'ACTIVE',
          startDate: new Date().toISOString(),
          totalEarned: 0,
          location: location || 'Kalgoorlie, Western Australia',
        });
      }
    }

    data.history.unshift({
      id: generateId('INV'),
      userId: user.id,
      phone: user.phone,
      type: 'DEPOSIT',
      amount: numAmount,
      carrier: 'SYSTEM',
      status: 'SUCCESSFUL',
      timestamp: new Date().toISOString(),
      description: `Deployed Mineral Node: ${productName} (${numAmount.toLocaleString()} frs @ 40% Daily Yield)`,
    });

    db.save();

    return res.json({
      success: true,
      message: `LAMINA Mineral Contract activated! Daily 40% yield: ${(numAmount * 0.40).toLocaleString()} frs/day.`,
      newBalance: user.balance,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to activate investment' });
  }
});

// -----------------------------------------------------------------
// 3-TIER REFERRAL NETWORK TREE
// -----------------------------------------------------------------

// GET /api/network
app.get('/api/network', (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || req.query.userId as string;
    const data = db.getData();

    const user = data.users.find(u => u.id === userId);
    if (!user) {
      return res.status(401).json({ error: 'User session not found. Please log in.' });
    }
    const myPhone = user.phone;

    const level1 = data.users.filter(u => u.referrerPhone === myPhone);
    const l1Phones = level1.map(u => u.phone);

    const level2 = data.users.filter(u => u.referrerPhone && l1Phones.includes(u.referrerPhone));
    const l2Phones = level2.map(u => u.phone);

    const level3 = data.users.filter(u => u.referrerPhone && l2Phones.includes(u.referrerPhone));

    const commissions = data.history.filter(h => h.userId === user.id && h.type === 'REFERRAL_COMMISSION');
    const totalCommissionEarned = commissions.reduce((sum, c) => sum + c.amount, 0);

    return res.json({
      userPhone: myPhone,
      affiliateLink: `?ref=${myPhone}`,
      totalCommissionEarned,
      level1: {
        rate: data.settings.commissionLevel1,
        count: level1.length,
        members: level1.map(m => ({
          phone: `${m.phone.slice(0, 3)}***${m.phone.slice(-3)}`,
          name: m.name,
          deposited: m.totalDeposited,
          joined: m.createdAt,
        })),
      },
      level2: {
        rate: data.settings.commissionLevel2,
        count: level2.length,
        members: level2.map(m => ({
          phone: `${m.phone.slice(0, 3)}***${m.phone.slice(-3)}`,
          name: m.name,
          deposited: m.totalDeposited,
          joined: m.createdAt,
        })),
      },
      level3: {
        rate: data.settings.commissionLevel3,
        count: level3.length,
        members: level3.map(m => ({
          phone: `${m.phone.slice(0, 3)}***${m.phone.slice(-3)}`,
          name: m.name,
          deposited: m.totalDeposited,
          joined: m.createdAt,
        })),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /api/live-ticker
app.get('/api/live-ticker', (_req: Request, res: Response) => {
  const feed = getLiveTickerFeed();
  return res.json({ feed });
});

// POST /api/engine/run-daily-dividend
app.post('/api/engine/run-daily-dividend', (req: Request, res: Response) => {
  try {
    const forceDate = req.body.forceDate;
    const result = runDailyDividendEngine(forceDate);
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------
// PRIVATE ACCESS & RELEASING OF FUNDS ADMIN VAULT
// Keys: LaminaVault2026 or MomoVault2026
// -----------------------------------------------------------------

function verifyAdminAuth(req: Request, res: Response, next: Function) {
  const secret = (req.query.secret || req.headers['x-admin-secret'] || req.body?.secret) as string;
  const validSecrets = ['LaminaVault2026', 'MomoVault2026'];
  if (!validSecrets.includes(secret)) {
    return res.status(403).json({ error: 'Access Denied: Invalid Master Clearance Passkey.' });
  }
  next();
}

// GET /api/admin/data
app.get('/api/admin/data', verifyAdminAuth, (_req: Request, res: Response) => {
  const data = db.getData();
  data.supportTickets = data.supportTickets || [];
  return res.json({
    users: data.users,
    investments: data.investments,
    history: data.history.slice(0, 50),
    payoutQueue: data.payoutQueue,
    depositQueue: data.depositQueue,
    supportTickets: data.supportTickets,
    engineLogs: data.engineLogs,
    fundReleaseLogs: data.fundReleaseLogs || [],
    settings: data.settings,
    metrics: {
      totalUsers: data.users.length,
      totalDeposits: data.users.reduce((sum, u) => sum + u.totalDeposited, 0),
      totalWithdrawn: data.users.reduce((sum, u) => sum + u.totalWithdrawn, 0),
      activeInvestmentsCapital: data.investments.filter(i => i.status === 'ACTIVE').reduce((sum, i) => sum + i.amountInvested, 0),
      pendingPayoutCount: data.payoutQueue.length,
      pendingDepositCount: data.depositQueue.length,
      pendingSupportCount: data.supportTickets.filter(t => t.status === 'PENDING').length,
      totalFundsReleasedCount: (data.fundReleaseLogs || []).length,
    },
  });
});

// Action link for approving and releasing payout: /api/admin/approve/TICKET_ID
app.all('/api/admin/approve/:ticketId', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const officerTitle = req.body?.officerTitle || 'Lead Australian Vault Officer';
    const result = adminApproveWithdrawal(ticketId, officerTitle);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Private Fund Release Execution
app.post('/api/admin/release-fund/:ticketId', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const officerTitle = req.body?.officerTitle || 'Chief Liquidity Officer';
    const result = adminApproveWithdrawal(ticketId, officerTitle);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Admin reject cashout ticket
app.post('/api/admin/reject/:ticketId', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const reason = req.body.reason || 'Verification flag not met';
    const result = adminRejectWithdrawal(ticketId, reason);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Admin approve deposit ticket (Cash-In)
app.post('/api/admin/approve-deposit/:ticketId', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const result = adminApproveDeposit(ticketId);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Admin reject deposit ticket (Cash-In)
app.post('/api/admin/reject-deposit/:ticketId', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const reason = req.body?.reason || 'Transfer verification mismatch';
    const result = adminRejectDeposit(ticketId, reason);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Admin update deposit numbers (MTN single number & Orange numbers + MoMo / OM Names)
app.post('/api/admin/update-deposit-numbers', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { mtn, orange, momoAccountName, orangeAccountName } = req.body;
    const data = db.getData();
    if (!data.settings.depositNumbers) {
      data.settings.depositNumbers = { mtn: [], orange: [] };
    }
    if (Array.isArray(mtn)) {
      data.settings.depositNumbers.mtn = mtn.map((n: string) => String(n).trim()).filter(Boolean);
    }
    if (Array.isArray(orange)) {
      data.settings.depositNumbers.orange = orange.map((n: string) => String(n).trim()).filter(Boolean);
    }
    if (typeof momoAccountName === 'string' && momoAccountName.trim()) {
      data.settings.momoAccountName = momoAccountName.trim();
    }
    if (typeof orangeAccountName === 'string' && orangeAccountName.trim()) {
      data.settings.orangeAccountName = orangeAccountName.trim();
    }
    db.save();
    return res.json({
      success: true,
      message: 'Deposit numbers and account names updated successfully.',
      depositNumbers: data.settings.depositNumbers,
      momoAccountName: data.settings.momoAccountName,
      orangeAccountName: data.settings.orangeAccountName,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Admin toggle auto-webhook mode
app.post('/api/admin/toggle-auto-webhook', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const data = db.getData();
    data.settings.autoWebhook = !data.settings.autoWebhook;
    db.save();
    return res.json({
      success: true,
      autoWebhook: data.settings.autoWebhook,
      message: `LAMINA Payment Pipeline mode switched to: ${data.settings.autoWebhook ? 'Automated Instant Webhook' : 'Private Admin Moderation Queue'}`,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Admin delete user account and all associated data
app.post('/api/admin/delete-user', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required.' });
    }

    const result = deleteUserAccount(userId);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Failed to delete account' });
  }
});

// -----------------------------------------------------------------
// CUSTOMER SERVICE DESK (+237 655 958 337)
// -----------------------------------------------------------------

// POST /api/support/ticket
app.post('/api/support/ticket', (req: Request, res: Response) => {
  try {
    const { phone, name, category, subject, message, relatedTicketId } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone number and message are required.' });
    }

    const data = db.getData();
    data.supportTickets = data.supportTickets || [];

    const ticketId = generateId('SUP');
    const newTicket = {
      id: ticketId,
      phone: phone.replace(/[^0-9]/g, ''),
      name: name?.trim() || 'LAMINA Member',
      category: category || 'GENERAL',
      subject: subject?.trim() || 'Customer Service Request',
      message: message.trim(),
      relatedTicketId: relatedTicketId?.trim() || undefined,
      status: 'PENDING' as const,
      createdAt: new Date().toISOString(),
    };

    data.supportTickets.unshift(newTicket);
    db.save();

    return res.json({
      success: true,
      ticketId,
      message: `Your inquiry has been registered under ticket ${ticketId}. Our Customer Service team (+237 655 958 337) will reach out promptly.`,
      ticket: newTicket,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to submit support ticket' });
  }
});

// POST /api/admin/support-tickets/:ticketId/resolve
app.post('/api/admin/support-tickets/:ticketId/resolve', verifyAdminAuth, (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const data = db.getData();
    data.supportTickets = data.supportTickets || [];

    const ticket = data.supportTickets.find(t => t.id === ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Support ticket not found.' });
    }

    ticket.status = 'RESOLVED';
    ticket.resolvedAt = new Date().toISOString();
    db.save();

    return res.json({ success: true, message: `Ticket ${ticketId} marked as RESOLVED.`, ticket });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin reset demo data
app.post('/api/admin/reset-demo', verifyAdminAuth, (_req: Request, res: Response) => {
  try {
    const reset = db.resetToDefault();
    return res.json({ success: true, message: 'Database reset to default seed state.', reset });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------
// VITE DEV SERVER / PRODUCTION STATIC
// -----------------------------------------------------------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LAMINA Mineral Cloud Mining Gateway (Australia) running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
