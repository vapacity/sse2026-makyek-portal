import * as web from 'express-decorators';
import _ from 'lodash';
import utils from '@/libs/utils';
import errors from '@/libs/errors';
import sanitizers from '@/libs/sanitizers';
import permissions from '@/libs/permissions';

@web.controller('/user')
export default class Handler {

  @web.use()
  async navType(req, res, next) {
    res.locals.nav_type = 'user';
    next();
  }

  @web.get('/welcome')
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async getWelcomeAction(req, res) {
    const udoc = req.credential;
    res.render('user_welcome', {
      page_title: 'Welcome',
      udoc,
    });
  }

  @web.post('/welcome')
  @web.middleware(utils.sanitizeBody({
    newPassword: sanitizers.nonEmptyString(),
    newPasswordRepeat: sanitizers.nonEmptyString(),
    displayName: sanitizers.nonEmptyString(),
  }))
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async postWelcomeAction(req, res) {
    if (req.data.newPassword !== req.data.newPasswordRepeat) {
      throw new errors.UserError('New password does not match your repeated password');
    }
    const udoc = req.credential;
    await udoc.setPasswordAsync(req.data.newPassword);
    udoc.passwordNeedsReset = false;
    udoc.profile.displayName = req.data.displayName;
    udoc.initial = false;
    await udoc.save();
    res.redirect(utils.url('/'));
  }

  @web.get('/account')
  @web.middleware(utils.checkWelcome())
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async getAccountAction(req, res) {
    const udoc = req.credential;
    res.render('user_account', {
      page_title: 'My Account',
      udoc,
    });
  }

  @web.post('/account')
  @web.middleware(utils.sanitizeBody({
    oldPassword: sanitizers.nonEmptyString(),
    newPassword: sanitizers.nonEmptyString(),
    newPasswordRepeat: sanitizers.nonEmptyString(),
  }))
  @web.middleware(utils.checkWelcome())
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async postAccountAction(req, res) {
    if (req.data.newPassword !== req.data.newPasswordRepeat) {
      throw new errors.UserError('New password does not match your repeated password');
    }
    const udoc = req.credential;
    const match = await udoc.testPasswordAsync(req.data.oldPassword);
    if (!match) {
      throw new errors.UserError('Incorrect current password');
    }
    await udoc.setPasswordAsync(req.data.newPassword);
    udoc.passwordNeedsReset = false;
    await udoc.save();
    res.redirect(utils.url('/user/account?updated'));
  }

  @web.get('/profile')
  @web.middleware(utils.checkWelcome())
  @web.middleware(utils.checkPasswordReset())
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async getUserProfileAction(req, res) {
    const udoc = req.credential;
    res.render('user_profile', {
      page_title: 'My Profile',
      udoc,
    });
  }

  @web.post('/profile')
  @web.middleware(utils.sanitizeBody({
    displayName: sanitizers.nonEmptyString(),
  }))
  @web.middleware(utils.checkWelcome())
  @web.middleware(utils.checkPasswordReset())
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async postUserProfileAction(req, res) {
    const udoc = req.credential;
    _.assign(udoc.profile, req.data);
    await udoc.save();
    res.redirect(utils.url('/user/profile?updated'));
  }

  @web.get('/settings')
  @web.middleware(utils.checkWelcome())
  @web.middleware(utils.checkPasswordReset())
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async getUserSettingsAction(req, res) {
    const udoc = req.credential;
    res.render('user_settings', {
      page_title: 'Settings',
      udoc,
    });
  }

  @web.post('/settings')
  @web.middleware(utils.sanitizeBody({
    compiler: sanitizers.nonEmptyString().in(_.keys(DI.config.compile.display)),
    hideId: sanitizers.bool(),
  }))
  @web.middleware(utils.checkWelcome())
  @web.middleware(utils.checkPasswordReset())
  @web.middleware(utils.checkPermission(permissions.PROFILE))
  async postUserSettingsAction(req, res) {
    const udoc = req.credential;
    _.assign(udoc.settings, req.data);
    await udoc.save();
    res.redirect(utils.url('/user/settings?updated'));
  }

}
