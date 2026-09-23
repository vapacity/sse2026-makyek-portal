import mongoose from 'mongoose';
import objectId from '@/libs/objectId';
import errors from '@/libs/errors';
import roles from '@/libs/roles';

export default () => {
  const UserSchema = new mongoose.Schema({
    userName: String,
    userName_std: String,
    role: String,
    hash: String,
    settings: {
      compiler: String,
      hideId: Boolean,
    },
    profile: {
      realName: String,
      studentId: String,
      displayName: String,
    },
    initial: Boolean,
    passwordNeedsReset: Boolean,
    submissionNumber: Number,
  }, {
    timestamps: true,
  });

  // User Model
  let User;

  /**
   * Normalize the userName
   * @return {String}
   */
  UserSchema.statics.normalizeUserName = function (userName) {
    return userName.toLowerCase().trim();
  };

  /**
   * Get user object by userName
   * @return {User} Mongoose user object
   */
  UserSchema.statics.getUserObjectByUserNameAsync = async function (userName, throwWhenNotFound = true) {
    const userNameNormalized = User.normalizeUserName(userName);
    const user = await User.findOne({ userName_std: userNameNormalized });
    if (user === null && throwWhenNotFound) {
      throw new errors.UserError('User not found');
    }
    return user;
  };

  /**
   * Get the user object by userId
   * @return {User} Mongoose user object
   */
  UserSchema.statics.getUserObjectByIdAsync = async function (id, throwWhenNotFound = true) {
    if (!objectId.isValid(id)) {
      if (throwWhenNotFound) {
        throw new errors.UserError('User not found');
      } else {
        return null;
      }
    }
    const user = await User.findOne({ _id: id });
    if (user === null && throwWhenNotFound) {
      throw new errors.UserError('User not found');
    }
    return user;
  };

  /**
   * Get all users, order by _id
   * @return {[User]}
   */
  UserSchema.statics.getAllUsersAsync = async function () {
    return await User.find().sort({ _id: 1 });
  };

  /**
   * Increase the submission counter of a user and return its new value
   *
   * @param  {MongoId} id User Id
   * @return {Number} Submission counter
   */
  UserSchema.statics.incAndGetSubmissionNumberAsync = async function (id) {
    if (!objectId.isValid(id)) {
      throw new errors.UserError('User not found');
    }
    const udoc = await User.findByIdAndUpdate(
      id,
      { $inc: { submissionNumber: 1 } },
      { new: true, select: { submissionNumber: 1 } }
    ).exec();
    return udoc.submissionNumber;
  };

  /**
   * Create a new account
   * @return {User} Newly created user object
   */
  UserSchema.statics.createUserAsync = async function (userName, password, studentId, realName, role = 'student') {
    if (await User.getUserObjectByUserNameAsync(userName, false) !== null) {
      throw new errors.UserError('Username already taken');
    }
    if (roles[role] === undefined) {
      throw new errors.UserError('Invalid role');
    }
    const newUser = new User({
      role,
      profile: {
        realName,
        studentId,
        displayName: userName,
      },
      settings: {
        compiler: '',
        hideId: true,
      },
      initial: true,
      passwordNeedsReset: true,
      submissionNumber: 0,
    });
    newUser.setUserName(userName);
    await newUser.setPasswordAsync(password);
    try {
      await newUser.save();
    } catch (e) {
      if (e.name === 'MongoError' && e.code === 11000) {
        // duplicate key error
        throw new errors.UserError('Username already taken');
      } else {
        throw e;
      }
    }
    return newUser;
  };

  /**
   * Set password for a user
   * @return {User} The updated user object
   */
  UserSchema.statics.setUserPasswordAsync = async function (userName, newPassword) {
    const user = await User.getUserObjectByUserNameAsync(userName);
    await user.setPasswordAsync(newPassword);
    user.passwordNeedsReset = true;
    await user.save();
    return user;
  };

  /**
   * Set role for a user
   * @return {User} The updated user object
   */
  UserSchema.statics.setUserRoleAsync = async function (userName, newRole) {
    if (roles[newRole] === undefined) {
      throw new errors.UserError('Invalid role');
    }
    const user = await User.getUserObjectByUserNameAsync(userName);
    user.role = newRole;
    await user.save();
    return user;
  };

  /**
   * Retrive an user object and verify its credential
   * @return {User} The user object if password matches
   */
  UserSchema.statics.authenticateAsync = async function (userName, password) {
    const user = await User.getUserObjectByUserNameAsync(userName);
    const match = await user.testPasswordAsync(password);
    if (!match) {
      throw new errors.UserError('Incorrect username or password');
    }
    return user;
  };

  /**
   * Check whether a user has some permissions
   * @return {Boolean}
   */
  UserSchema.methods.hasPermission = function (perm) {
    if (this.role === undefined) {
      return false;
    }
    if (roles[this.role] === undefined) {
      return false;
    }
    return (roles[this.role] & perm) !== 0;
  };

  /**
   * Set the userName and userName_std
   */
  UserSchema.methods.setUserName = function (userName) {
    this.userName = userName;
    this.userName_std = UserSchema.statics.normalizeUserName(userName);
  };

  /**
   * Set the password hash
   */
  UserSchema.methods.setPasswordAsync = async function (plain) {
    this.hash = plain;
  };

  /**
   * Test whether a password matches the hash
   */
  UserSchema.methods.testPasswordAsync = async function (password) {
    return this.hash === password;
  };

  UserSchema.index({ userName_std: 1 }, { unique: true });

  User = mongoose.model('User', UserSchema);
  return User;

};
