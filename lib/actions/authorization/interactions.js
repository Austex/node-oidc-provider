const url = require('url');

const { upperFirst, camelCase } = require('lodash');
const Debug = require('debug');

const started = new Debug('oidc-provider:authentication:interrupted');
const accepted = new Debug('oidc-provider:authentication:accepted');

const errors = require('../../helpers/errors');
const instance = require('../../helpers/weak_cache');

/* eslint-disable no-restricted-syntax, no-await-in-loop */

module.exports = async function interactions(resumeRouteName, ctx, next) {
  const { oidc } = ctx;
  let failedCheck;
  let prompt;

  for (const { name, checks, details: promptDetails } of instance(oidc.provider).configuration('interactions')) {
    let results = (await Promise.all([...checks].map(async ({
      reason, description, error, details, check,
    }) => {
      if (await check(ctx)) {
        return {
          [reason]: { error, description, details: await details(ctx) },
        };
      }

      return undefined;
    }))).filter(Boolean);

    if (results.length) {
      results = Object.assign({}, ...results);
      prompt = {
        name,
        reasons: Object.keys(results),
        details: Object.assign(
          {},
          await promptDetails(ctx),
          ...Object.values(results).map(r => r.details),
        ),
      };

      const [[, { error, description }]] = Object.entries(results);
      failedCheck = {
        error: error || 'interaction_required',
        error_description: description || 'interaction is required from the end-user',
      };
      break;
    }
  }

  // no interaction requested
  if (!prompt) {
    // check there's an accountId to continue
    if (!oidc.session.accountId()) {
      throw new errors.AccessDenied(undefined, 'request resolved without requesting interactions but no account id was resolved');
    }

    // check there's something granted to continue
    // if only claims parameter is used then it must be combined with openid scope anyway
    // when no scope paramater was provided and none is injected by the AS policy access is
    // denied rather then issuing a code/token without scopes
    if (!oidc.acceptedScope()) {
      throw new errors.AccessDenied(undefined, 'request resolved without requesting interactions but scope was granted');
    }

    accepted('uid=%s %o', oidc.uid, oidc.params);
    oidc.provider.emit('authorization.accepted', ctx);
    await next();
    return;
  }

  // if interaction needed but prompt=none => throw;
  try {
    if (oidc.promptPending('none')) {
      const className = upperFirst(camelCase(failedCheck.error));
      if (errors[className]) {
        throw new errors[className](failedCheck.error_description);
      } else {
        ctx.throw(400, failedCheck.error, { error_description: failedCheck.error_description });
      }
    }
  } catch (err) {
    const code = /^(code|device)_/.test(oidc.route) ? 400 : 302;
    err.status = code;
    err.statusCode = code;
    err.expose = true;
    throw err;
  }

  const cookieOptions = instance(oidc.provider).configuration('cookies.short');
  const returnTo = oidc.urlFor(resumeRouteName, {
    uid: oidc.uid,
    ...(oidc.deviceCode ? { user_code: oidc.deviceCode.userCode } : undefined),
  });

  const interactionSession = new oidc.provider.Interaction(oidc.uid, {
    returnTo,
    prompt,
    lastSubmission: oidc.result,
    accountId: oidc.session.accountId(),
    uid: oidc.uid,
    params: oidc.params.toPlainObject(),
    signed: oidc.signed,
    session: oidc.session.accountId() ? {
      accountId: oidc.session.accountId(),
      ...(oidc.session.uid ? { uid: oidc.session.uid } : undefined),
      ...(oidc.session.jti ? { cookie: oidc.session.jti } : undefined),
      ...(oidc.session.acr ? { acr: oidc.session.acr } : undefined),
      ...(oidc.session.amr ? { amr: oidc.session.amr } : undefined),
    } : undefined,
  });

  await interactionSession.save(cookieOptions.maxAge / 1000);

  const destination = await instance(oidc.provider).configuration('interactionUrl')(ctx, interactionSession);

  ctx.cookies.set(
    oidc.provider.cookieName('interaction'),
    oidc.uid,
    { path: url.parse(destination).pathname, ...cookieOptions },
  );

  ctx.cookies.set(
    oidc.provider.cookieName('resume'),
    oidc.uid,
    { ...cookieOptions, path: url.parse(returnTo).pathname },
  );

  started('uid=%s interaction=%o', ctx.oidc.uid, interactionSession);
  oidc.provider.emit('interaction.started', ctx, prompt);
  ctx.redirect(destination);
};
