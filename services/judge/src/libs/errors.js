import ExtendableError from 'es6-error';

class UserError extends ExtendableError {
}

class BrainError extends UserError {
  constructor(id, message) {
    super(message);
    this.id = id;
  }
}

const errors = {
  UserError,
  BrainError,
};

export default errors;
