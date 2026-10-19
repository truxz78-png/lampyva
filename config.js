// Lampyva settings — change only the values in quotes.
window.LAMPYVA = {
  // Your PayPal donation link (paypal.me or PayPal "Donate" link).
  paypal: "PAYPAL_LINK_HERE"
};

document.addEventListener("DOMContentLoaded", function () {
  var link = window.LAMPYVA.paypal;
  document.querySelectorAll("[data-donate]").forEach(function (a) {
    if (link.indexOf("http") === 0) {
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener";
    }
  });
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
});
