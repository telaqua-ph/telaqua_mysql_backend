import bcrypt from "bcryptjs";

const password = "TelaquaPh02";

bcrypt.hash(password, 12).then(hash => {
  console.log(hash);
});