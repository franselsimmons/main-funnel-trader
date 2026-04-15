export function getRiskProfile(strategy){

  switch(strategy){

    case "SCALP_FAST":
      return { risk:0.3, rr:1.5 };

    case "SCALP":
      return { risk:0.5, rr:2 };

    case "AGGRESSIVE":
      return { risk:1.2, rr:3 };

    case "SWING":
      return { risk:1, rr:2.5 };

    case "DEFENSIVE":
      return { risk:0.4, rr:1.8 };

    default:
      return { risk:0.5, rr:2 };
  }
}